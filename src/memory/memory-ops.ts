/**
 * Explicit memory operations (save / update / forget / search).
 *
 * These are the gateway-side primitives behind the MCP tools
 * (`memory_save`, `memory_update`, `memory_forget`, `memory_search`). They
 * reuse the existing deterministic memory engine (`persistCandidates`,
 * `applyCandidate`, `updateItemAtomic`, `listMemoryItems`) so the MCP path and
 * the normal chat path share identical memory behavior. The MCP layer never
 * touches the database directly — it calls these through the Gateway.
 */
import { eq } from "drizzle-orm";
import type { Database } from "../db";
import { memoryItems, type MemoryItem } from "../db/schema/memory";
import {
  MemoryStatus,
  MemoryType,
  type CandidateMemory,
  type MemoryScores,
  type FactScope,
} from "../models/memory";
import { persistCandidates, listMemoryItems } from "./state";
import { updateItemAtomic } from "./concurrency";
import { retrieveMemories } from "./retrieve";
import { slugify, structuredFactToContent, structuredFactToTopicKey } from "./facts";
import { warn } from "../log";

export interface SaveMemoryInput {
  userId: string;
  /** Entity (subject), e.g. "user", "project", a project name. */
  subject?: string;
  /** Attribute (predicate), e.g. "name", "database". */
  attribute?: string;
  /** Value of the fact. */
  value: string;
  /** Canonical memory type. Defaults to FACT. */
  type?: string;
  /** Memory scope. Defaults to "user" when subject is "user", else "project". */
  scope?: FactScope;
  /** Authority of the write. Defaults to "user" for explicit saves. */
  authority?: "user" | "assistant" | "speculation";
}

export interface SearchMemoryInput {
  userId: string;
  query: string;
  limit?: number;
}

/**
 * Build a `CandidateMemory` from explicit structured fields and persist it
 * through the standard contradiction/merge/supersede engine. Returns the applied
 * result.
 */
export async function saveMemory(
  db: Database,
  input: SaveMemoryInput
): Promise<{
  action: string;
  reason?: string;
  item?: MemoryItem | null;
  superseded?: MemoryItem | null;
}> {
  const value = String(input.value ?? "").trim();
  if (!value) {
    return { action: "skip", reason: "empty_value" };
  }

  const subject = (input.subject || "user").trim();
  const attribute = (input.attribute || "").trim();
  const mtype = normalizeMemoryType(input.type);
  const scope = resolveScope(input.scope, subject);

  const content =
    mtype === MemoryType.PREFERENCE && !attribute
      ? value
      : structuredFactToContent({
          entity: subject,
          attribute: attribute || "item",
          value,
          memoryType: mtype,
          rawText: value,
        });

  const topicKey =
    mtype === MemoryType.PREFERENCE && !attribute
      ? `preference:${slugify(value)}`
      : structuredFactToTopicKey({
          entity: subject,
          attribute: attribute || "item",
          value,
          memoryType: mtype,
          rawText: value,
        });

  const candidate: CandidateMemory = {
    content,
    type: mtype,
    scores: {
      confidence: 0,
      importance: 0,
      stability: 0,
      freshness: 1,
      informationGain: 0,
    },
    sourceMessageIds: [`manual:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`],
    topicKey,
    authority: input.authority ?? "user",
    isCorrection: false,
    subject,
    predicate: attribute || undefined,
    value,
    scope,
    structuredFact: {
      entity: subject,
      attribute: attribute || "item",
      value,
      memoryType: mtype,
      rawText: value,
      scope,
    },
  };

  const results = await persistCandidates(db, input.userId, [candidate]);
  const r = results[0];
  return {
    action: r.action,
    reason: r.reason,
    item: r.item,
    superseded: r.superseded,
  };
}

/**
 * Update an existing memory item's value by matching its id (or topic), marking
 * the old item SUPERSEDED and writing a new ACTIVE item with the new value.
 * Returns the new item.
 */
export async function updateMemory(
  db: Database,
  userId: string,
  opts: {
    id?: number;
    topicKey?: string;
    value: string;
    attribute?: string;
    subject?: string;
    type?: string;
  }
): Promise<{
  action: string;
  reason?: string;
  item?: MemoryItem | null;
  superseded?: MemoryItem | null;
}> {
  const value = String(opts.value ?? "").trim();
  if (!value) {
    return { action: "skip", reason: "empty_value" };
  }

  const active = await listMemoryItems(db, userId, MemoryStatus.ACTIVE);
  let target: MemoryItem | null = null;

  if (opts.id != null) {
    target = active.find((i) => i.id === opts.id) ?? null;
  } else if (opts.topicKey) {
    const topic = opts.topicKey.trim().toLowerCase();
    target = active.find((i) => (i.topicKey || "").toLowerCase() === topic) ?? null;
  }

  if (!target) {
    // No existing item: treat update as a create.
    return saveMemory(db, {
      userId,
      subject: opts.subject,
      attribute: opts.attribute,
      value,
      type: opts.type,
    });
  }

  const nowIso = new Date().toISOString();
  const ok = await updateItemAtomic(db, target.id, target.version, {
    status: MemoryStatus.SUPERSEDED,
    updatedAt: nowIso,
  });
  if (!ok) {
    return { action: "conflict", reason: "update_conflict" };
  }

  const subject = opts.subject || target.subject || "user";
  const attribute = opts.attribute || target.predicate || "item";
  const mtype = normalizeMemoryType(opts.type || target.type);
  const content = structuredFactToContent({
    entity: subject,
    attribute,
    value,
    memoryType: mtype,
    rawText: value,
  });
  const topicKey = target.topicKey || structuredFactToTopicKey({
    entity: subject,
    attribute,
    value,
    memoryType: mtype,
    rawText: value,
  });

  const scores: MemoryScores = {
    confidence: 0.95,
    importance: Math.max(target.importance, 0.8),
    stability: 0.6,
    freshness: 1,
    informationGain: 0.85,
  };

  const [inserted] = await db
    .insert(memoryItems)
    .values({
      userId,
      content,
      type: mtype,
      topicKey,
      subject,
      predicate: attribute,
      value,
      scope: target.scope || "project",
      confidence: scores.confidence,
      importance: scores.importance,
      stability: scores.stability,
      freshness: scores.freshness,
      informationGain: scores.informationGain,
      sourceMessageIdsJson: target.sourceMessageIdsJson,
      supersedesId: target.id,
      status: MemoryStatus.ACTIVE,
      version: target.version + 1,
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    .returning();

  const created = inserted;
  if (!created) {
    return { action: "conflict", reason: "insert_failed" };
  }

  return { action: "supersede", item: created, superseded: target, reason: "update" };
}

/**
 * Forget (revoke) a memory item or all items matching a topic/attribute. Revoked
 * items are preserved in the archive (per the lifecycle invariant) but excluded
 * from compiled context.
 */
export async function forgetMemory(
  db: Database,
  userId: string,
  opts: { id?: number; topicKey?: string; attribute?: string; content?: string }
): Promise<{ action: string; removed: MemoryItem[] }> {
  const active = await listMemoryItems(db, userId, MemoryStatus.ACTIVE);
  let targets: MemoryItem[] = [];

  if (opts.id != null) {
    targets = active.filter((i) => i.id === opts.id);
  } else if (opts.topicKey) {
    const topic = opts.topicKey.trim().toLowerCase();
    targets = active.filter((i) => (i.topicKey || "").toLowerCase() === topic);
  } else if (opts.attribute) {
    const attribute = opts.attribute.trim().toLowerCase();
    targets = active.filter((i) => (i.predicate || "").toLowerCase() === attribute);
  } else if (opts.content) {
    const needle = opts.content.toLowerCase();
    targets = active.filter((i) => i.content.toLowerCase().includes(needle));
  }

  if (targets.length === 0) {
    return { action: "noop", removed: [] };
  }

  const nowIso = new Date().toISOString();
  const removed: MemoryItem[] = [];
  for (const target of targets) {
    const ok = await updateItemAtomic(db, target.id, target.version, {
      status: MemoryStatus.REVOKED,
      updatedAt: nowIso,
    });
    if (ok) {
      target.status = MemoryStatus.REVOKED;
      removed.push(target);
    }
  }

  return { action: removed.length > 0 ? "revoke" : "noop", removed };
}

/**
 * Deterministic persistent-memory search. Delegates to the existing retrieval
 * engine (keyword/subject/predicate/scope filters). No embeddings yet.
 */
export async function searchMemory(
  db: Database,
  input: SearchMemoryInput
): Promise<MemoryItem[]> {
  const terms = String(input.query || "")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1);

  const results = await retrieveMemories(db, {
    userId: input.userId,
    keywords: terms.length > 0 ? terms.slice(0, 12) : undefined,
    status: MemoryStatus.ACTIVE,
    order: "importance",
    limit: input.limit ?? 20,
  });
  return results.map((r) => r.item);
}

export function normalizeMemoryType(type?: string): MemoryType {
  const t = (type || "fact").trim().toLowerCase();
  const valid = Object.values(MemoryType);
  if (valid.includes(t as MemoryType)) {
    return t as MemoryType;
  }
  warn("memory-ops", "unknown memory type; falling back to FACT", { type });
  return MemoryType.FACT;
}

function resolveScope(scope: FactScope | undefined, subject: string): FactScope {
  if (scope) return scope;
  if (subject.toLowerCase() === "user") return "user";
  return "project";
}
