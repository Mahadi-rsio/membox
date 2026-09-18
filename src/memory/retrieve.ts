/**
 * Deterministic retrieval for long-term memories.
 *
 * No embeddings. Retrieval uses exact/structured filters: subject, predicate,
 * scope, status, confidence/importance/stability thresholds, recency, and
 * current-vs-historical state. When embeddings are added later they become an
 * ADDITIONAL retrieval strategy layered on top — not a rewrite of this engine.
 */
import { and, eq, gte, lte, desc, or, like, inArray } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { memoryItems, type MemoryItem } from "../db/schema/memory.js";
import { MemoryStatus } from "../models/memory.js";
import { parseIdList } from "./contradiction.js";

export interface MemoryRetrievalQuery {
  userId: string;
  /** Filter by the entity (subject) e.g. "user", "project", a project name. */
  subject?: string;
  /** Filter by attribute (predicate) e.g. "database", "runtime". */
  predicate?: string;
  /** Filter by scope: "user" | "project" | "session". */
  scope?: string;
  /** Filter by lifecycle status. Defaults to ACTIVE for current-state queries. */
  status?: string | string[];
  /** Include superseded/historical items (current vs historical). */
  includeHistorical?: boolean;
  /** Keyword substring match against content / value. */
  keyword?: string;
  /** Multiple keywords matched as OR (any keyword in content/value/predicate). */
  keywords?: string[];
  minConfidence?: number;
  minImportance?: number;
  minStability?: number;
  /** Only items updated/created within this many seconds (recency). */
  recencySeconds?: number;
  limit?: number;
  order?: "recency" | "importance" | "confidence";
}

export interface RetrievedMemory {
  item: MemoryItem;
  current: boolean;
}

/**
 * Retrieve long-term memories deterministically. `current` distinguishes
 * currently-active facts from superseded/revoked historical ones.
 */
export async function retrieveMemories(
  db: Database,
  query: MemoryRetrievalQuery
): Promise<RetrievedMemory[]> {
  const conditions = [eq(memoryItems.userId, query.userId)];

  if (query.subject) {
    conditions.push(eq(memoryItems.subject, query.subject));
  }
  if (query.predicate) {
    conditions.push(eq(memoryItems.predicate, query.predicate));
  }
  if (query.scope) {
    conditions.push(eq(memoryItems.scope, query.scope));
  }
  if (query.minConfidence !== undefined) {
    conditions.push(gte(memoryItems.confidence, query.minConfidence));
  }
  if (query.minImportance !== undefined) {
    conditions.push(gte(memoryItems.importance, query.minImportance));
  }
  if (query.minStability !== undefined) {
    conditions.push(gte(memoryItems.stability, query.minStability));
  }

  if (query.includeHistorical) {
    // All statuses.
  } else {
    const statuses =
      query.status === undefined
        ? [MemoryStatus.ACTIVE]
        : Array.isArray(query.status)
          ? query.status
          : [query.status];
    if (statuses.length === 1) {
      conditions.push(eq(memoryItems.status, statuses[0]));
    } else {
      conditions.push(
        or(...statuses.map((s) => eq(memoryItems.status, s))) as any
      );
    }
  }

  if (query.keyword) {
    const pattern = `%${query.keyword.trim()}%`;
    conditions.push(
      or(
        like(memoryItems.content, pattern),
        like(memoryItems.value, pattern),
        like(memoryItems.predicate, pattern)
      ) as any
    );
  }

  if (query.keywords && query.keywords.length > 0) {
    const terms = query.keywords
      .map((k) => k.trim())
      .filter((k) => k.length > 1);
    if (terms.length > 0) {
      conditions.push(
        or(
          ...terms.map((t) => {
            const p = `%${t}%`;
            return or(
              like(memoryItems.content, p),
              like(memoryItems.value, p),
              like(memoryItems.predicate, p),
              like(memoryItems.subject, p),
              like(memoryItems.topicKey, p)
            ) as any;
          })
        ) as any
      );
    }
  }

  if (query.recencySeconds !== undefined && query.recencySeconds > 0) {
    const cutoff = new Date(Date.now() - query.recencySeconds * 1000).toISOString();
    conditions.push(gte(memoryItems.updatedAt, cutoff));
  }

  const orderBy =
    query.order === "importance"
      ? desc(memoryItems.importance)
      : query.order === "confidence"
        ? desc(memoryItems.confidence)
        : desc(memoryItems.updatedAt);

  const rows = await db
    .select()
    .from(memoryItems)
    .where(and(...conditions))
    .orderBy(orderBy)
    .limit(query.limit ?? 20);

  return rows.map((item) => ({
    item,
    current: item.status === MemoryStatus.ACTIVE,
  }));
}

/**
 * Convenience: retrieve only currently-active memories, optionally filtered by
 * predicate/scope — used by the context composer to answer
 * "What should we remember long-term?".
 */
export async function retrieveActiveMemories(
  db: Database,
  userId: string,
  options?: {
    subject?: string;
    predicate?: string;
    scope?: string;
    keyword?: string;
    keywords?: string[];
    minImportance?: number;
    limit?: number;
  }
): Promise<MemoryItem[]> {
  const result = await retrieveMemories(db, {
    userId,
    subject: options?.subject,
    predicate: options?.predicate,
    scope: options?.scope,
    keyword: options?.keyword,
    keywords: options?.keywords,
    minImportance: options?.minImportance,
    limit: options?.limit,
    status: MemoryStatus.ACTIVE,
  });
  return result.map((r) => r.item);
}

/**
 * Relationship expansion — the 4th stage of the retrieval pipeline.
 *
 * Given a set of seed memories (from scope filtering + structured/lexical
 * retrieval + scoring), follow first-class relationship links (`supersedesId`,
 * `contradictsIdsJson`, `relatedMemoryIdsJson`) to pull in connected items that
 * provide relevant context (e.g. the fact a memory superseded, or the memory a
 * candidate was derived from). This avoids re-loading the whole dataset while
 * still surfacing strongly-related history.
 */
export async function expandRelations(
  db: Database,
  userId: string,
  seeds: MemoryItem[],
  options?: {
    /** Max relationship hops to follow (default 1). */
    depth?: number;
    /** Only return currently-active related items (default true). */
    activeOnly?: boolean;
    limit?: number;
  }
): Promise<MemoryItem[]> {
  if (!seeds || seeds.length === 0) {
    return [];
  }

  const seen = new Map<number, MemoryItem>();
  for (const s of seeds) {
    seen.set(s.id, s);
  }

  const frontier = [...seeds];
  const depth = options?.depth ?? 1;

  for (let hop = 0; hop < depth && frontier.length > 0; hop++) {
    const linkedIds = new Set<number>();
    const targets: number[] = [];

    for (const item of frontier) {
      if (item.supersedesId != null) {
        targets.push(item.supersedesId);
        linkedIds.add(item.supersedesId);
      }
      for (const id of parseIdList(item.contradictsIdsJson)) {
        targets.push(id);
        linkedIds.add(id);
      }
      for (const id of parseIdList(item.relatedMemoryIdsJson)) {
        targets.push(id);
        linkedIds.add(id);
      }
    }

    if (targets.length === 0) {
      break;
    }

    const next: MemoryItem[] = [];
    // Load by batches of ids, excluding ones we already have.
    for (let i = 0; i < targets.length; i += 500) {
      const batch = targets.slice(i, i + 500).filter((id) => !seen.has(id));
      if (batch.length === 0) {
        continue;
      }
      const rows = await db
        .select()
        .from(memoryItems)
        .where(
          and(
            eq(memoryItems.userId, userId),
            inArray(memoryItems.id, batch),
            options?.activeOnly === false
              ? undefined
              : eq(memoryItems.status, MemoryStatus.ACTIVE)
          )
        );
      for (const r of rows) {
        if (!seen.has(r.id)) {
          seen.set(r.id, r);
          next.push(r);
        }
      }
    }

    frontier.length = 0;
    frontier.push(...next);
  }

  const out = Array.from(seen.values()).filter((i) => !seeds.some((s) => s.id === i.id));
  return out.slice(0, options?.limit ?? out.length);
}
