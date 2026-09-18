/**
 * Memory Analyzer — three-way classification of extracted candidates.
 *
 * Every candidate is routed into exactly one bucket:
 *   - "store"   → durable, long-term information → PostgreSQL
 *   - "context" → temporary, "what's happening right now" → Redis (short-term)
 *   - "discard" → irrelevant / noise → dropped entirely
 *
 * The analyzer also derives the structured (subject, predicate, value) triple
 * and temporal validity window that the long-term store persists.
 */
import {
  MemoryBucket,
  MemoryType,
  type CandidateMemory,
  type FactScope,
} from "../models/memory.js";
import { isPreferenceNoiseValue } from "./facts.js";

/** Markers that signal transient, currently-happening information. */
const CONTEXT_MARKERS =
  /\b(currently|right now|at the moment|in progress|ongoing|debugging|working on|current (task|error|issue|bug)|the (error|issue|bug) is|is broken|temporarily|for now)\b/i;

/** Markers that signal a durable, stable fact or preference. */
const DURABLE_MARKERS =
  /\b(i (am|use|prefer)|my name|we use|uses|prefer|decided|chose|switched to|migrated to|built with|is built (on|with)|running on)\b/i;

/** Types that are inherently durable (never temporary context). */
const DURABLE_TYPES: ReadonlySet<MemoryType> = new Set([
  MemoryType.FACT,
  MemoryType.DECISION,
  MemoryType.CONSTRAINT,
  MemoryType.PREFERENCE,
  MemoryType.GOAL,
  MemoryType.ARCHITECTURE,
  MemoryType.IMPORTANT_EVENT,
]);

/** Explicit "current task / error / debugging" context keys. */
const CONTEXT_KEYS: ReadonlySet<string> = new Set([
  "current_task",
  "current_error",
  "active_debugging_context",
  "recent_decisions",
  "temporary_entities",
]);

/** Pure filler / noise tokens (a superset of the low-info phrase list). */
const NOISE_WORDS: ReadonlySet<string> = new Set([
  "haha", "lol", "ok", "okay", "k", "kk", "yes", "yeah", "yep", "yup", "no",
  "nope", "nah", "thanks", "thank", "thx", "ty", "cool", "great", "nice",
  "good", "fine", "sure", "got", "gotcha", "lgtm", "ack", "right", "hm",
  "hmm", "huh", "please", "pls", "perfect", "awesome", "agreed", "alright",
  "understood", "works", "sounds", "awesome",
]);

function isNoise(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .replace(/[^\w\s+]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return true;
  if (NOISE_WORDS.has(normalized)) return true;
  const words = normalized.split(" ").filter(Boolean);
  if (words.length === 0) return true;
  return words.every((w) => NOISE_WORDS.has(w));
}

export interface AnalyzedCandidate {
  candidate: CandidateMemory;
  bucket: MemoryBucket;
}

export function deriveContextKey(candidate: CandidateMemory): string {
  const text = candidate.content.toLowerCase();
  if (/\b(debug|debugging)\b/.test(text)) {
    return "active_debugging_context";
  }
  if (/\b(error|bug|exception|failed|failure)\b/.test(text)) {
    return "current_error";
  }
  if (/\b(task|working on|doing|implementing|fixing|building now)\b/.test(text)) {
    return "current_task";
  }
  return "recent_decisions";
}

export function deriveStructuredFields(candidate: CandidateMemory): {
  subject: string;
  predicate: string;
  value: string;
  scope: FactScope;
} {
  const fact = candidate.structuredFact;
  if (fact) {
    const scope = fact.scope || "project";
    return {
      subject: fact.entity || "project",
      predicate: fact.attribute || "attribute",
      value: fact.value || candidate.content,
      scope,
    };
  }

  // Fallback: parse "Key = value" / "Key: value" style content.
  const kv = candidate.content.trim().match(/^([A-Za-z][\w\s/-]{0,40}?)\s*(?:=| is | are |:=|:)\s*(.+)$/i);
  if (kv && kv[1] && kv[2]) {
    return {
      subject: "project",
      predicate: kv[1].trim().toLowerCase().replace(/\s+/g, "_"),
      value: kv[2].trim(),
      scope: "project",
    };
  }

  return {
    subject: "project",
    predicate: candidate.type,
    value: candidate.content,
    scope: "project",
  };
}

/**
 * Decide whether a candidate should be stored durably, kept as temporary
 * context, or discarded as noise.
 */
export function classifyCandidate(candidate: CandidateMemory): MemoryBucket {
  const text = candidate.content.trim();
  const lower = text.toLowerCase();

  // Pure filler / acknowledgement noise → discard entirely.
  if (isNoise(lower)) {
    return MemoryBucket.DISCARD;
  }

  // Preference over-store guard: "I love this response" / demonstrative values.
  if (candidate.type === MemoryType.PREFERENCE) {
    const prefValue = candidate.value || candidate.structuredFact?.value || text;
    if (isPreferenceNoiseValue(prefValue)) {
      return MemoryBucket.DISCARD;
    }
  }

  // Explicitly-flagged temporary / transient information → context.
  if (CONTEXT_MARKERS.test(lower)) {
    return MemoryBucket.CONTEXT;
  }

  // Correction / revocation of a durable fact must be stored durably.
  if (candidate.isCorrection || candidate.correction || candidate.revocation) {
    return MemoryBucket.STORE;
  }

  // Durable types with durable content → store.
  if (DURABLE_TYPES.has(candidate.type)) {
    if (DURABLE_MARKERS.test(lower) || candidate.structuredFact || candidate.topicKey) {
      return MemoryBucket.STORE;
    }
    return MemoryBucket.STORE;
  }

  // Active task / active task type → temporary context by default.
  if (
    candidate.type === MemoryType.ACTIVE_TASK ||
    candidate.type === MemoryType.TEMPORARY_STATE
  ) {
    return MemoryBucket.CONTEXT;
  }

  // Anything without a durable shape that isn't clearly context → discard.
  return MemoryBucket.DISCARD;
}

/**
 * Analyze a set of candidates and produce per-candidate buckets plus the
 * short-term context entries (with TTL) that should be written to Redis.
 */
export function analyzeCandidates(candidates: CandidateMemory[]): {
  store: CandidateMemory[];
  context: CandidateMemory[];
  discard: CandidateMemory[];
  contextEntries: Array<{ key: string; value: string; ttlSeconds: number }>;
} {
  const store: CandidateMemory[] = [];
  const context: CandidateMemory[] = [];
  const discard: CandidateMemory[] = [];
  const contextEntries: Array<{ key: string; value: string; ttlSeconds: number }> = [];

  for (const candidate of candidates) {
    const bucket = classifyCandidate(candidate);
    candidate.bucket = bucket;

    const structured = deriveStructuredFields(candidate);
    candidate.subject = structured.subject;
    candidate.predicate = structured.predicate;
    candidate.value = structured.value;
    candidate.scope = structured.scope;

    switch (bucket) {
      case MemoryBucket.STORE:
        store.push(candidate);
        break;
      case MemoryBucket.CONTEXT: {
        context.push(candidate);
        const key = deriveContextKey(candidate);
        const ttlSeconds = key === "current_error" ? 3600 : 7200;
        contextEntries.push({ key, value: candidate.content, ttlSeconds });
        break;
      }
      case MemoryBucket.DISCARD:
      default:
        discard.push(candidate);
        break;
    }
  }

  return { store, context, discard, contextEntries };
}

export { CONTEXT_MARKERS, DURABLE_MARKERS, CONTEXT_KEYS };
