import type { Database } from "../db/index.js";
import type { DeltaResult } from "./delta.js";
import type { ApplyResult } from "./contradiction.js";
import type { CandidateMemory, MemoryAIOutput } from "../models/memory.js";
import type { ShortTermContextStore } from "./context-store.js";
import { extractCandidates } from "./extractor.js";
import { isLowInfoMessage } from "./low-info.js";
import { analyzeCandidates } from "./analyzer.js";
import type { ExtractionFallbackOptions } from "./extractor.js";
import { info, debug } from "../log.js";
import { memoryAiOutputToCandidates } from "./compressor.js";
import {
  latestContextVersion,
  listMemoryItems,
  markItemsObsolete,
  memoryChanged,
  persistCandidates,
  writeContextVersion,
} from "./state.js";
import { MemoryStatus, snapshotFromItems } from "../models/memory.js";
import type { MemoryAIAdapter } from "../providers/memory-ai.js";
import { runConsolidationPass } from "./consolidator.js";

export interface MemoryUpdateResult {
  userId: string;
  skippedLowInfo?: boolean;
  candidates: number;
  stored: number;
  contextCount: number;
  discarded: number;
  applied: ApplyResult[];
  obsoleteMarked: number;
  contextVersion?: number | null;
  consolidated?: number;
  consolidationSuperseded?: number;
  error?: string | null;
}

export async function processMemoryDelta(
  db: Database,
  delta: DeltaResult,
  options?: {
    memoryAiOutput?: MemoryAIOutput | null;
    contextStore?: ShortTermContextStore | null;
    /** Optional Memory AI for cluster consolidation (falls back to deterministic). */
    memoryAi?: MemoryAIAdapter | null;
    /** Optional Groq extraction fallback when local extraction yields nothing. */
    groq?: ExtractionFallbackOptions | null;
  }
): Promise<MemoryUpdateResult | null> {
  const base = {
    userId: delta.userId,
    candidates: 0,
    stored: 0,
    contextCount: 0,
    discarded: 0,
    applied: [],
    obsoleteMarked: 0,
  };

  if (!delta.allMessages || delta.allMessages.length === 0) {
    return { ...base };
  }

  const meaningful = delta.allMessages.filter(
    (m) => ["user", "assistant"].includes(m.role) && !isLowInfoMessage(m.content, m.role)
  );

  if (meaningful.length === 0) {
    return {
      ...base,
      skippedLowInfo: true,
    };
  }

  try {
    // Extract from ALL messages — including duplicates already in the archive.
    // A message may have been archived before its facts were extracted (bug,
    // outage, older extractor). Re-extraction is safe: the store layer skips
    // near-duplicate facts via information gain, so no rows are duplicated.
    const reprocessingDuplicates = delta.duplicateMessages.length > 0;
    if (reprocessingDuplicates) {
      info("extract", "re-processing archived (duplicate) messages for extraction", {
        userId: delta.userId,
        duplicates: delta.duplicateMessages.length,
      });
    }
    const candidates: CandidateMemory[] = await extractCandidates(
      delta.allMessages,
      options?.groq ?? undefined
    );
    const sourceIds = delta.allMessages.map((m) => m.messageKey);

    info("extract", "candidates extracted from messages", {
      userId: delta.userId,
      messages: delta.allMessages.length,
      newMessages: delta.newMessages.length,
      duplicates: delta.duplicateMessages.length,
      candidates: candidates.length,
    });

    const memoryAiOutput = options?.memoryAiOutput;
    if (memoryAiOutput) {
      const aiCandidates = memoryAiOutputToCandidates(memoryAiOutput, sourceIds);
      const existingContents = new Set(candidates.map((c) => c.content.toLowerCase()));
      for (const aiC of aiCandidates) {
        if (!existingContents.has(aiC.content.toLowerCase())) {
          candidates.push(aiC);
          existingContents.add(aiC.content.toLowerCase());
        }
      }
    }

    // Memory Analyzer: route each candidate to store / context / discard.
    const { store, discard, contextEntries } = analyzeCandidates(candidates);

    info("analyzer", "three-way classification complete", {
      userId: delta.userId,
      candidates: candidates.length,
      store: store.length,
      context: contextEntries.length,
      discard: discard.length,
    });
    debug("analyzer", "routed candidates", {
      userId: delta.userId,
      stored: store.map((c) => c.content),
      context: contextEntries.map((e) => `${e.key}=${e.value}`),
      discarded: discard.map((c) => c.content),
    });

    let results: ApplyResult[] = [];
    if (store.length > 0) {
      results = await persistCandidates(db, delta.userId, store);
      info("store", "long-term candidates persisted to PostgreSQL", {
        userId: delta.userId,
        applied: results.length,
        actions: results.map((r) => r.action),
      });
    } else {
      info("store", "no durable candidates to persist", {
        userId: delta.userId,
      });
    }

    // Persist short-term context (Redis / in-memory store).
    let contextCount = 0;
    const contextStore = options?.contextStore;
    if (contextStore && contextEntries.length > 0) {
      for (const entry of contextEntries) {
        try {
          await contextStore.setContext(
            delta.userId,
            entry.key,
            entry.value,
            entry.ttlSeconds
          );
          contextCount++;
        } catch {
          // fail-open: context persistence must never break the main path
        }
      }
      info("context-store", "short-term context persisted", {
        userId: delta.userId,
        written: contextCount,
        keys: contextEntries.map((e) => e.key),
      });
    }

    let obsoleteCount = 0;
    if (memoryAiOutput && memoryAiOutput.obsolete_items.length > 0) {
      const marked = await markItemsObsolete(
        db,
        delta.userId,
        memoryAiOutput.obsolete_items
      );
      obsoleteCount = marked.length;
    }

    let versionNum: number | null = null;
    if (memoryChanged(results, obsoleteCount)) {
      versionNum = await writeContextVersion(db, delta.userId, sourceIds);
    }

    // Consolidation after writes — deterministic by default; Memory AI optional.
    let consolidated = 0;
    let consolidationSuperseded = 0;
    try {
      const pass = await runConsolidationPass(db, delta.userId, {
        memoryAi: options?.memoryAi ?? null,
      });
      consolidated = pass.created;
      consolidationSuperseded = pass.superseded;
      if (consolidated > 0 && versionNum == null) {
        versionNum = await latestContextVersion(db, delta.userId);
      }
    } catch {
      // fail-open
    }

    const result = {
      userId: delta.userId,
      candidates: candidates.length,
      stored: store.length,
      contextCount,
      discarded: discard.length,
      applied: results,
      obsoleteMarked: obsoleteCount,
      contextVersion: versionNum,
      consolidated,
      consolidationSuperseded,
    };

    info("engine", "memory pipeline complete", {
      userId: delta.userId,
      candidates: result.candidates,
      stored: result.stored,
      contextCount: result.contextCount,
      discarded: result.discarded,
      consolidated: result.consolidated,
      consolidationSuperseded: result.consolidationSuperseded,
      contextVersion: result.contextVersion,
    });

    return result;
  } catch (err: any) {
    return {
      userId: delta.userId,
      candidates: 0,
      stored: 0,
      contextCount: 0,
      discarded: 0,
      applied: [],
      obsoleteMarked: 0,
      error: err?.message || String(err),
    };
  }
}

export async function processMemoryDeltaAsync(
  db: Database,
  delta: DeltaResult,
  options?: {
    memoryAi?: MemoryAIAdapter | null;
    contextStore?: ShortTermContextStore | null;
    groq?: ExtractionFallbackOptions | null;
  }
): Promise<MemoryUpdateResult | null> {
  const base = {
    userId: delta.userId,
    candidates: 0,
    stored: 0,
    contextCount: 0,
    discarded: 0,
    applied: [],
    obsoleteMarked: 0,
  };

  if (!delta.allMessages || delta.allMessages.length === 0) {
    return { ...base };
  }

  const meaningful = delta.allMessages.filter(
    (m) => ["user", "assistant"].includes(m.role) && !isLowInfoMessage(m.content, m.role)
  );

  if (meaningful.length === 0) {
    return {
      ...base,
      skippedLowInfo: true,
    };
  }

  let aiOutput: MemoryAIOutput | null = null;
  const memoryAi = options?.memoryAi;

  if (memoryAi) {
    try {
      const messagesText = delta.allMessages
        .filter((m) => m.content)
        .map((m) => `${m.role}: ${m.content}`)
        .join("\n");

      let priorSummary: string | null = null;
      try {
        const active = await listMemoryItems(db, delta.userId, MemoryStatus.ACTIVE);
        if (active.length > 0) {
          priorSummary = JSON.stringify(snapshotFromItems(active));
        }
      } catch {}

      aiOutput = await memoryAi.extractMemory(messagesText, priorSummary);
    } catch {
      aiOutput = null;
    }
  }

  return await processMemoryDelta(db, delta, {
    memoryAiOutput: aiOutput,
    contextStore: options?.contextStore,
    memoryAi: memoryAi ?? null,
    groq: options?.groq ?? null,
  });
}
