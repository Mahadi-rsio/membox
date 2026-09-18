import type { Database } from "../db/index.js";
import { assembleContextMessages } from "./assembler.js";
import {
  extractKeywords,
  scoreCanonicalItem,
  scoreMessageItem,
  selectItemsForBudget,
  type SelectableItem,
} from "./selector.js";
import { estimateMessagesTokens, estimateTokens } from "./tokens.js";
import { compressToolMessage } from "../memory/compressor.js";
import { normalizeMessage } from "../memory/ids.js";
import {
  latestContextVersion,
  resolveActiveConflicts,
} from "../memory/state.js";
import { retrieveActiveMemories, expandRelations } from "../memory/retrieve.js";
import type { ShortTermContextStore } from "../memory/context-store.js";
import type { MemoryAIAdapter } from "../providers/memory-ai.js";
import { contextVersions } from "../db/schema/context.js";
import { info, debug } from "../log.js";

export interface CompileResult {
  messages: Array<Record<string, any>>;
  totalTokens: number;
  contextVersion?: number | null;
  canonicalItemsUsed: number;
  shortTermItemsUsed: number;
  selectedCount: number;
  budget: number;
}

async function persistContextSnapshot(
  db: Database,
  userId: string,
  compiledMessages: Array<Record<string, any>>,
  options: {
    budget: number;
    totalTokens: number;
    canonicalCount: number;
    sourceMessageIds: string[];
  }
): Promise<number | null> {
  try {
    const nextVer = (await latestContextVersion(db, userId)) + 1;
    const stateData = {
      budget: options.budget,
      total_tokens: options.totalTokens,
      message_count: compiledMessages.length,
      canonical_items_count: options.canonicalCount,
    };
    await db.insert(contextVersions).values({
      userId,
      version: nextVer,
      stateJson: JSON.stringify(stateData),
      sourceMessageIdsJson: JSON.stringify(options.sourceMessageIds),
      createdAt: new Date().toISOString(),
    });
    return nextVer;
  } catch {
    return null;
  }
}

export async function compileContext(
  db: Database | null,
  messages: Array<Record<string, any>>,
  userId?: string | null,
  options?: {
    budget?: number;
    memoryAi?: MemoryAIAdapter | null;
    persistSnapshot?: boolean;
    contextStore?: ShortTermContextStore | null;
  }
): Promise<CompileResult> {
  const targetBudget = options?.budget || 8000;

  if (!messages || messages.length === 0) {
    return {
      messages: [],
      totalTokens: 0,
      budget: targetBudget,
      canonicalItemsUsed: 0,
      shortTermItemsUsed: 0,
      selectedCount: 0,
    };
  }

  try {
    let latestUserText = "";
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        latestUserText = String(messages[i].content || "");
        break;
      }
    }
    const inputTokensBeforeRetrieval = estimateMessagesTokens(messages);
    info("compiler", "user message received", {
      userId: userId ?? null,
      latestUserMessage: latestUserText.slice(0, 500),
      latestUserMessageTokens: estimateTokens(latestUserText),
      messagesIn: messages.length,
      messagesInTokens: inputTokensBeforeRetrieval,
    });
    const queryKeywords = extractKeywords(latestUserText);
    // Prefer longer / rarer terms so long questions don't drop "neon"/"database"
    // when the first 6 tokens are filler verbs.
    const rankedKeywords = [...queryKeywords].sort((a, b) => b.length - a.length || a.localeCompare(b));

    let canonicalItems: any[] = [];
    let retrievedActive: any[] = [];
    if (db && userId) {
      try {
        // Lexical retrieval: pull the active long-term set narrowed by the
        // query keywords (OR match against content/value/predicate/subject),
        // then expand first-class relationships (supersedes/contradicts/
        // related) so we surface connected history without loading the whole
        // dataset. We deliberately do NOT hard-filter by scope: AI-extracted
        // scopes are unreliable, so a hard scope filter causes false negatives.
        const keywordList =
          rankedKeywords.length > 0 ? rankedKeywords.slice(0, 12) : undefined;
        retrievedActive = await retrieveActiveMemories(db, userId, {
          keywords: keywordList,
          limit: 40,
        });

        // Fallback: sparse keyword hits (common on long multi-hop questions)
        // still need high-importance durable memories in context.
        if (retrievedActive.length < 4) {
          const top = await retrieveActiveMemories(db, userId, { limit: 20 });
          const byId = new Map(retrievedActive.map((i) => [i.id, i]));
          for (const item of top) {
            if (!byId.has(item.id)) byId.set(item.id, item);
          }
          retrievedActive = Array.from(byId.values());
        }

        // Always keep durable user identity/location/preference facts in reach
        // so tense/paraphrased questions ("Where I lived", "my name", "what I
        // prefer") recall correctly even when the query words don't lexically
        // match the stored value ("Bangladesh" vs "lived").
        const durableUser = await retrieveActiveMemories(db, userId, {
          scope: "user",
          limit: 40,
        });
        const byId = new Map(retrievedActive.map((i) => [i.id, i]));
        for (const item of durableUser) {
          if (item.type === "fact" || item.type === "preference" || item.type === "constraint") {
            if (!byId.has(item.id)) byId.set(item.id, item);
          }
        }
        retrievedActive = Array.from(byId.values());

        const wantsHistory =
          /\b(used to|previously|before|old|former|was|were|history|superseded|changed from)\b/i.test(
            latestUserText
          );

        const expanded = await expandRelations(db, userId, retrievedActive, {
          depth: 1,
          activeOnly: !wantsHistory,
          limit: 20,
        });
        const merged = new Map<number, any>();
        for (const item of [...retrievedActive, ...expanded]) {
          merged.set(item.id, item);
        }
        canonicalItems = resolveActiveConflicts(Array.from(merged.values()));
        // When history is requested, keep superseded items that expandRelations
        // returned so the model can contrast old vs new.
        if (wantsHistory) {
          for (const item of expanded) {
            if (item.status === "superseded" && !merged.has(item.id)) {
              merged.set(item.id, item);
            }
          }
          // resolveActiveConflicts drops superseded same-topic; re-add historical
          // siblings explicitly for contrast questions.
          const historical = expanded.filter((i) => i.status === "superseded");
          const activeResolved = resolveActiveConflicts(Array.from(merged.values()));
          const histExtra = historical.filter(
            (h) => !activeResolved.some((a) => a.id === h.id)
          );
          canonicalItems = [...activeResolved, ...histExtra];
        }
        info("retrieve", "long-term memories retrieved", {
          userId,
          keywords: rankedKeywords.slice(0, 12),
          retrieved: retrievedActive.length,
          expanded: expanded.length,
          canonicalAfterConflictResolve: canonicalItems.length,
          wantsHistory,
        });
        debug("retrieve", "retrieved facts", {
          userId,
          facts: retrievedActive.map((i) => ({
            id: i.id,
            attribute: i.predicate,
            value: i.value,
            scope: i.scope,
            type: i.type,
            status: i.status,
            generatedBy: "local",
          })),
        });
      } catch {}
    }

    // Short-term context from Redis (or in-memory store) — "what's happening right now?"
    let shortTermText = "";
    let shortTermItemsUsed = 0;
    const contextStore = options?.contextStore;
    if (contextStore && userId) {
      try {
        const ctx = await contextStore.getAllContext(userId);
        if (ctx && ctx.length > 0) {
          const lines = ctx.map((e) => `• ${e.key}: ${e.value}`);
          shortTermText = `[Short-Term Context (current state)]\n${lines.join("\n")}`;
          shortTermItemsUsed = ctx.length;
          info("retrieve", "short-term context retrieved", {
            userId,
            items: ctx.length,
            keys: ctx.map((e) => e.key),
          });
        } else {
          info("retrieve", "no short-term context found", { userId });
        }
      } catch {}
    }

    const processedMessages: Array<Record<string, any>> = [];
    for (let idx = 0; idx < messages.length; idx++) {
      const m = messages[idx];
      const contentStr = String(m.content || "");
      if (m.role === "tool" && contentStr.length > 400) {
        let compressed = contentStr;
        if (options?.memoryAi) {
          try {
            const norm = normalizeMessage(m, idx);
            compressed = await compressToolMessage(norm, options.memoryAi);
          } catch {
            compressed = contentStr;
          }
        } else if (contentStr.length > 1000) {
          const lines = contentStr.split("\n");
          const head = lines.slice(0, 10).join("\n");
          compressed = `${head}\n... [tool output truncated for context budget: ${lines.length} lines total]`;
        }
        processedMessages.push({ ...m, content: compressed });
      } else {
        processedMessages.push(m);
      }
    }

    const candidates: SelectableItem[] = [];
    const totalMsgs = processedMessages.length;

    for (let idx = 0; idx < totalMsgs; idx++) {
      const isLatest = idx === totalMsgs - 1;
      const item = scoreMessageItem(processedMessages[idx], {
        index: idx,
        totalMessages: totalMsgs,
        queryKeywords,
        isLatest,
      });
      candidates.push(item);
    }

    for (let cIdx = 0; cIdx < canonicalItems.length; cIdx++) {
      const item = scoreCanonicalItem(canonicalItems[cIdx], {
        ordinal: 100000 + cIdx,
        queryKeywords,
      });
      candidates.push(item);
    }

    // Deterministic retrieval happened above (scope-first + relationship
    // expansion); `retrievedActive` holds the active long-term set.

    const currentTokens = estimateMessagesTokens(messages);
    if (retrievedActive.length === 0 && shortTermItemsUsed === 0 && currentTokens <= targetBudget) {
      let versionNum: number | null = null;
      if (db && userId && options?.persistSnapshot !== false) {
        versionNum = await persistContextSnapshot(db, userId, messages, {
          budget: targetBudget,
          totalTokens: currentTokens,
          canonicalCount: 0,
          sourceMessageIds: messages.map((m, idx) => String(m.id || idx)),
        });
      }
      return {
        messages,
        totalTokens: currentTokens,
        contextVersion: versionNum,
        canonicalItemsUsed: 0,
        shortTermItemsUsed: 0,
        selectedCount: messages.length,
        budget: targetBudget,
      };
    }

    const selected = selectItemsForBudget(candidates, targetBudget);
    const selectedMessageCount = selected.filter((s) => s.kind === "message").length;
    const selectedCanonicalCount = selected.filter((s) => s.kind === "canonical_memory").length;
    info("compiler", "items selected within context budget", {
      userId: userId ?? null,
      candidates: candidates.length,
      selected: selected.length,
      selectedMessages: selectedMessageCount,
      selectedCanonical: selectedCanonicalCount,
      canonicalSelected: selectedCanonicalCount,
      budget: targetBudget,
    });

    // Prepend the short-term context block to the assembled system prompt.
    let compiledMessages = assembleContextMessages(selected, {
      hasCanonicalMemory: retrievedActive.length > 0,
    });
    if (shortTermText) {
      const sysIdx = compiledMessages.findIndex((m) => m.role === "system");
      if (sysIdx !== -1) {
        const existing = String(compiledMessages[sysIdx].content || "");
        compiledMessages[sysIdx].content = `${existing}\n\n${shortTermText}`.trim();
      } else {
        compiledMessages.unshift({ role: "system", content: shortTermText });
      }
    }

    const finalTokens = estimateMessagesTokens(compiledMessages);
    const canonicalUsed = selected.filter((s) => s.kind === "canonical_memory").length;

    let versionNum: number | null = null;
    if (db && userId && options?.persistSnapshot !== false) {
      const sourceIds = selected.map((s) => s.itemId);
      versionNum = await persistContextSnapshot(db, userId, compiledMessages, {
        budget: targetBudget,
        totalTokens: finalTokens,
        canonicalCount: canonicalUsed,
        sourceMessageIds: sourceIds,
      });
    }

    info("compiler", "context compiled for upstream", {
      userId: userId ?? null,
      messagesIn: messages.length,
      messagesOut: compiledMessages.length,
      messagesInTokens: inputTokensBeforeRetrieval,
      totalTokens: finalTokens,
      tokenDelta: finalTokens - inputTokensBeforeRetrieval,
      tokenReductionPct:
        inputTokensBeforeRetrieval > 0
          ? Math.round(((inputTokensBeforeRetrieval - finalTokens) / inputTokensBeforeRetrieval) * 100)
          : 0,
      canonicalItemsUsed: canonicalUsed,
      shortTermItemsUsed,
      selectedCount: selected.length,
      budget: targetBudget,
      contextVersion: versionNum,
    });

    return {
      messages: compiledMessages,
      totalTokens: finalTokens,
      contextVersion: versionNum,
      canonicalItemsUsed: canonicalUsed,
      shortTermItemsUsed,
      selectedCount: selected.length,
      budget: targetBudget,
    };
  } catch {
    info("compiler", "context compilation failed; forwarding original messages", {
      userId: userId ?? null,
      messages: messages.length,
    });
    return {
      messages,
      totalTokens: estimateMessagesTokens(messages),
      budget: targetBudget,
      canonicalItemsUsed: 0,
      shortTermItemsUsed: 0,
      selectedCount: messages.length,
    };
  }
}
