import { eq, and, desc } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { memoryItems, type MemoryItem } from "../db/schema/memory.js";
import { corrections } from "../db/schema/corrections.js";
import { contextVersions } from "../db/schema/context.js";
import { info, debug } from "../log.js";
import {
  type CandidateMemory,
  MemoryStatus,
  snapshotFromItems,
} from "../models/memory.js";
import {
  type ApplyResult,
  applyCandidate,
  loadActiveItems,
} from "./contradiction.js";

export async function listMemoryItems(
  db: Database,
  userId: string,
  status: string | null = MemoryStatus.ACTIVE
): Promise<MemoryItem[]> {
  if (status !== null) {
    return await db
      .select()
      .from(memoryItems)
      .where(
        and(
          eq(memoryItems.userId, userId),
          eq(memoryItems.status, status)
        )
      );
  }
  return await db
    .select()
    .from(memoryItems)
    .where(eq(memoryItems.userId, userId));
}

export function resolveActiveConflicts(items: MemoryItem[]): MemoryItem[] {
  const byTopic: Record<string, MemoryItem> = {};
  const independent: MemoryItem[] = [];

  for (const item of items) {
    const topic = (item.topicKey || "").trim();
    if (!topic) {
      independent.push(item);
      continue;
    }
    const existing = byTopic[topic];
    if (!existing) {
      byTopic[topic] = item;
      continue;
    }
    if (
      item.version > existing.version ||
      (item.version === existing.version && item.updatedAt > existing.updatedAt)
    ) {
      byTopic[topic] = item;
    }
  }

  return [...independent, ...Object.values(byTopic)];
}

export async function latestContextVersion(
  db: Database,
  userId: string
): Promise<number> {
  const rows = await db
    .select({ version: contextVersions.version })
    .from(contextVersions)
    .where(eq(contextVersions.userId, userId))
    .orderBy(desc(contextVersions.version))
    .limit(1);

  return rows.length > 0 ? rows[0].version : 0;
}

export async function persistCandidates(
  db: Database,
  userId: string,
  candidates: CandidateMemory[]
): Promise<ApplyResult[]> {
  const results: ApplyResult[] = [];
  let active = await loadActiveItems(db, userId);

  for (const candidate of candidates) {
    let result = await applyCandidate(db, userId, candidate, active);

    // Optimistic-concurrency conflict: a concurrent request modified the
    // item between our read and our write. Reload the current active set and
    // retry once (re-read version → update → merge on fresh state).
    if (result.action === "conflict") {
      active = await loadActiveItems(db, userId);
      result = await applyCandidate(db, userId, candidate, active);
    }

    results.push(result);

    const storedActions = new Set(["create", "merge", "supersede"]);
    const stored = storedActions.has(result.action);
    const factDesc = {
      type: candidate.type,
      subject: candidate.subject,
      predicate: candidate.predicate,
      value: candidate.value,
      topicKey: candidate.topicKey,
      generatedBy: candidate.structuredFact?.route ?? "local",
    };
    if (stored) {
      info("store", "fact written to PostgreSQL", {
        userId,
        action: result.action,
        reason: result.reason,
        ...factDesc,
        id: result.item?.id ?? null,
        supersededId: result.superseded?.id ?? null,
      });
    } else if (result.action === "revoke") {
      info("store", "fact revoked in PostgreSQL", {
        userId,
        reason: result.reason,
        revoked: (result.revoked ?? []).map((i) => i.id),
      });
    } else {
      info("store", "fact NOT stored", {
        userId,
        action: result.action,
        reason: result.reason,
        ...factDesc,
      });
    }
    debug("store", "apply result detail", {
      userId,
      action: result.action,
      reason: result.reason,
      factDesc,
      conflictItemId: result.conflictItemId ?? null,
    });

    if (result.correction && result.action === "supersede" && result.item) {
      await db.insert(corrections).values({
        userId,
        target: result.correction.target,
        oldValue: result.correction.oldValue,
        newValue: result.correction.newValue,
        status: "active",
        sourceMessageIdsJson: JSON.stringify(candidate.sourceMessageIds),
        createdAt: new Date().toISOString(),
      });
    }

    if (result.action === "create" && result.item) {
      active.push(result.item);
    } else if (result.action === "supersede" && result.item) {
      active = active.filter((i) => i.id !== result.superseded?.id);
      active.push(result.item);
    } else if (result.action === "revoke" && result.revoked) {
      const revokedIds = new Set(result.revoked.map((i) => i.id));
      active = active.filter((i) => !revokedIds.has(i.id));
    }
  }

  return results;
}

export async function writeContextVersion(
  db: Database,
  userId: string,
  sourceMessageIds: string[]
): Promise<number> {
  const active = await listMemoryItems(db, userId, MemoryStatus.ACTIVE);
  const snapshot = snapshotFromItems(active);
  const nextVersion = (await latestContextVersion(db, userId)) + 1;

  await db.insert(contextVersions).values({
    userId,
    version: nextVersion,
    stateJson: JSON.stringify(snapshot),
    sourceMessageIdsJson: JSON.stringify(sourceMessageIds),
    createdAt: new Date().toISOString(),
  });

  return nextVersion;
}

export async function markItemsObsolete(
  db: Database,
  userId: string,
  obsoleteDescriptions: string[]
): Promise<MemoryItem[]> {
  if (!obsoleteDescriptions || obsoleteDescriptions.length === 0) {
    return [];
  }
  const active = await listMemoryItems(db, userId, MemoryStatus.ACTIVE);
  const marked: MemoryItem[] = [];
  const nowIso = new Date().toISOString();

  for (const desc of obsoleteDescriptions) {
    const descClean = desc.trim().toLowerCase();
    if (!descClean) continue;
    for (const item of active) {
      if (marked.some((m) => m.id === item.id)) continue;
      const itemClean = item.content.toLowerCase();
      const topicClean = (item.topicKey || "").toLowerCase();
      if (
        descClean.includes(itemClean) ||
        itemClean.includes(descClean) ||
        (topicClean && descClean.includes(topicClean))
      ) {
        await db
          .update(memoryItems)
          .set({ status: MemoryStatus.OBSOLETE, updatedAt: nowIso })
          .where(eq(memoryItems.id, item.id));
        item.status = MemoryStatus.OBSOLETE;
        item.updatedAt = nowIso;
        marked.push(item);
      }
    }
  }

  return marked;
}

export function memoryChanged(results: ApplyResult[], obsoleteCount = 0): boolean {
  return (
    results.some((r) => ["create", "merge", "supersede", "revoke"].includes(r.action)) ||
    obsoleteCount > 0
  );
}
