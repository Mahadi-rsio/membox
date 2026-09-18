import {
  MemoryBucket,
  MemoryType,
  type CandidateMemory,
  type FactScope,
  type MemoryAIOutput,
  type StructuredFact,
} from "../models/memory.js";
import type { NormalizedMessage } from "./ids.js";
import { scoreCandidate } from "./scorer.js";
import type { MemoryAIAdapter } from "../providers/memory-ai.js";

const TYPE_MAP: Record<string, MemoryType> = {
  FACT: MemoryType.FACT,
  PREFERENCE: MemoryType.PREFERENCE,
  DECISION: MemoryType.DECISION,
  GOAL: MemoryType.GOAL,
  CONSTRAINT: MemoryType.CONSTRAINT,
  ARCHITECTURE: MemoryType.ARCHITECTURE,
  IMPORTANT_EVENT: MemoryType.IMPORTANT_EVENT,
  ACTIVE_TASK: MemoryType.ACTIVE_TASK,
  TEMPORARY_STATE: MemoryType.TEMPORARY_STATE,
};

function mapScope(scope: string): FactScope {
  const s = scope.toLowerCase();
  if (s === "user" || s === "session") return s;
  return "project";
}

function mapDestination(dest: string): MemoryBucket {
  switch (dest.toUpperCase()) {
    case "CONTEXT":
      return MemoryBucket.CONTEXT;
    case "DISCARD":
      return MemoryBucket.DISCARD;
    default:
      return MemoryBucket.STORE;
  }
}

export function memoryAiOutputToCandidates(
  output: MemoryAIOutput,
  sourceMessageIds: string[]
): CandidateMemory[] {
  const candidates: CandidateMemory[] = [];

  for (const item of output.candidates || []) {
    if (!item.value?.trim()) continue;
    if (item.destination === "DISCARD" || item.action === "DISCARD") continue;

    const mtype = TYPE_MAP[item.type.toUpperCase()] || MemoryType.FACT;
    const scope = mapScope(item.scope);
    const topicKey =
      item.topicKey?.trim() ||
      `${scope}.${item.predicate || "attribute"}`;

    const sfact: StructuredFact = {
      entity: item.subject || "user",
      attribute: item.predicate,
      value: item.value,
      memoryType: mtype,
      rawText: item.rawText || item.value,
      key: topicKey,
      scope,
      isUpdate: item.action === "SUPERSEDES" || item.action === "CONTRADICTS",
    };

    // Preferences store value-only content (existing convention).
    const content =
      mtype === MemoryType.PREFERENCE
        ? item.value
        : item.rawText || `${item.predicate}: ${item.value}`;

    const candidate: CandidateMemory = {
      content,
      type: mtype,
      scores: {
        confidence: item.confidence,
        importance: item.importance,
        stability:
          item.stability === "permanent"
            ? 1
            : item.stability === "long-term"
              ? 0.85
              : item.stability === "short-term"
                ? 0.5
                : 0.25,
        freshness: 1,
        informationGain: item.informationGain,
      },
      sourceMessageIds: [...sourceMessageIds],
      topicKey,
      authority: "user",
      isCorrection: item.action === "SUPERSEDES" || item.action === "CONTRADICTS",
      bucket: mapDestination(item.destination),
      subject: item.subject,
      predicate: item.predicate,
      value: item.value,
      scope,
      structuredFact: sfact,
    };

    if (item.ttl_hours != null && item.ttl_hours > 0) {
      const until = new Date(Date.now() + item.ttl_hours * 3600 * 1000).toISOString();
      candidate.validUntil = until;
    }

    const scored = scoreCandidate(candidate);
    scored.confidence = Math.min(
      1,
      Math.max(0, item.confidence * Math.max(0.85, scored.confidence || item.confidence))
    );
    scored.informationGain = Math.max(item.informationGain, scored.informationGain);
    scored.importance = Math.max(item.importance, scored.importance);
    candidate.scores = scored;
    candidates.push(candidate);
  }

  return candidates;
}

export async function compressToolMessage(
  message: NormalizedMessage,
  adapter?: MemoryAIAdapter | null
): Promise<string> {
  if (message.role !== "tool") {
    return message.content;
  }

  const toolName =
    message.raw.name || message.raw.tool_name || message.raw.tool_call_id || "tool";

  if (!adapter) {
    return message.content;
  }

  try {
    return await adapter.compressToolOutput(String(toolName), message.content);
  } catch {
    return message.content;
  }
}
