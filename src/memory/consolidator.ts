/**
 * Memory Consolidation Engine — merge related atomic memories into compact,
 * higher-quality records (e.g. 4 stack preferences → 1 ARCHITECTURE memory).
 *
 * Deterministic-first; optional Memory AI refinement when enabled.
 * Fail-open: consolidation errors never break the main memory / proxy path.
 */
import { inArray } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { memoryItems, type MemoryItem } from "../db/schema/memory.js";
import {
  MemoryRelationship,
  MemoryStatus,
  MemoryType,
  type ConsolidationConflict,
  type ConsolidationResult,
  type ConsolidatedMemory,
} from "../models/memory.js";
import type { MemoryAIAdapter } from "../providers/memory-ai.js";
import { listMemoryItems, writeContextVersion } from "./state.js";

/** Minimum related memories before a cluster is worth consolidating. */
export const MIN_CLUSTER_SIZE = 3;

/** Max consolidated outputs per cluster (per prompt contract). */
export const MAX_CONSOLIDATED_PER_CLUSTER = 2;

const STABILITY_LABEL_TO_SCORE: Record<string, number> = {
  permanent: 1.0,
  "long-term": 0.85,
  "short-term": 0.5,
  session: 0.25,
};

const STABILITY_SCORE_TO_LABEL = (
  score: number
): ConsolidatedMemory["stability"] => {
  if (score >= 0.95) return "permanent";
  if (score >= 0.7) return "long-term";
  if (score >= 0.4) return "short-term";
  return "session";
};

/**
 * Predicate → structured tech-stack field.
 * Excludes colors, disliked_*, and unrelated preferences.
 */
export const TECH_STACK_FIELD_MAP: Record<string, string> = {
  language: "language",
  preferred_language: "language",
  database: "database",
  preferred_database: "database",
  runtime: "runtime",
  preferred_runtime: "runtime",
  hosting: "runtime",
  framework: "framework",
  preferred_framework: "framework",
  frontend: "frontend",
  frontend_framework: "frontend",
  ui_library: "ui_library",
  cache: "cache",
  preferred_cache: "cache",
  storage: "storage",
  preferred_storage: "storage",
  technology: "technology",
};

export function stabilityLabelToScore(label: string): number {
  return STABILITY_LABEL_TO_SCORE[label] ?? 0.85;
}

export function stabilityScoreToLabel(
  score: number
): ConsolidatedMemory["stability"] {
  return STABILITY_SCORE_TO_LABEL(score);
}

function normalizePredicate(item: MemoryItem): string {
  const p = (item.predicate || "").trim().toLowerCase();
  if (p) return p;
  const topic = (item.topicKey || "").toLowerCase();
  const after = topic.includes(":") ? topic.split(":").pop() : topic.split(".").pop();
  return (after || "").trim();
}

function stackFieldForItem(item: MemoryItem): string | null {
  const pred = normalizePredicate(item);
  if (!pred || pred.startsWith("disliked_") || pred.startsWith("favorite_")) {
    return null;
  }
  if (TECH_STACK_FIELD_MAP[pred]) return TECH_STACK_FIELD_MAP[pred];
  // topicKey preference:language etc.
  const topic = (item.topicKey || "").toLowerCase();
  for (const [key, field] of Object.entries(TECH_STACK_FIELD_MAP)) {
    if (topic.endsWith(`.${key}`) || topic.endsWith(`:${key}`) || topic === key) {
      return field;
    }
  }
  // Generic "preference" / unknown predicate — classify from the value text.
  const val = `${item.value || ""} ${item.content || ""}`.toLowerCase();
  if (/\b(typescript|javascript|python|golang|java|ruby|php|swift|kotlin)\b/.test(val)) {
    return "language";
  }
  if (/\b(neon|postgres|postgresql|mysql|sqlite|mongodb|turso|supabase|redis)\b/.test(val)) {
    return "database";
  }
  if (/\b(cloudflare|workers|deno|nodejs|bun|lambda|vercel|netlify)\b/.test(val)) {
    return "runtime";
  }
  if (/\b(hono|express|fastify|next|nuxt|django|flask|fastapi)\b/.test(val)) {
    return "framework";
  }
  if (/\b(tailwind|mui|shadcn|bootstrap|chakra)\b/.test(val)) {
    return "ui_library";
  }
  return null;
}

/**
 * Assign a cluster topic for consolidation, or null if the item is not
 * part of a known consolidatable family.
 */
export function clusterTopicForItem(item: MemoryItem): string | null {
  const topic = (item.topicKey || "").trim().toLowerCase();
  if (topic === "user.tech_stack" || topic === "project.tech_stack") {
    return topic;
  }
  if (stackFieldForItem(item)) {
    const scope =
      (item.scope || "").toLowerCase() === "user" ||
      (item.subject || "").toLowerCase() === "user"
        ? "user"
        : "project";
    return `${scope}.tech_stack`;
  }
  return null;
}

export interface MemoryCluster {
  topic: string;
  items: MemoryItem[];
}

/** Group active memories into consolidatable clusters (size ≥ minSize). */
export function findConsolidationClusters(
  items: MemoryItem[],
  minSize = MIN_CLUSTER_SIZE
): MemoryCluster[] {
  const byTopic = new Map<string, MemoryItem[]>();
  for (const item of items) {
    if (item.status && item.status !== MemoryStatus.ACTIVE) continue;
    const topic = clusterTopicForItem(item);
    if (!topic) continue;
    const list = byTopic.get(topic) || [];
    list.push(item);
    byTopic.set(topic, list);
  }

  const clusters: MemoryCluster[] = [];
  for (const [topic, members] of byTopic) {
    // Need ≥ minSize atomic (non-consolidated) items, OR a mix that includes
    // new atomics alongside an existing consolidated record.
    const atomics = members.filter(
      (m) => (m.topicKey || "").toLowerCase() !== topic
    );
    const hasConsolidated = members.some(
      (m) => (m.topicKey || "").toLowerCase() === topic
    );
    // Re-fold leftovers: existing consolidated + ≥1 new atomic is enough.
    if (
      atomics.length >= minSize ||
      (atomics.length >= 2 && members.length >= minSize) ||
      (hasConsolidated && atomics.length >= 1)
    ) {
      clusters.push({ topic, items: members });
    }
  }
  return clusters;
}

function weightedConfidence(items: MemoryItem[]): number {
  if (items.length === 0) return 0;
  const total = items.reduce((s, i) => s + (i.confidence || 0), 0);
  return Number((total / items.length).toFixed(3));
}

function formatStructuredContent(
  predicate: string,
  value: Record<string, unknown>
): string {
  const parts = Object.entries(value).map(([k, v]) => `${k}=${String(v)}`);
  const title = predicate
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  return `${title}: ${parts.join(", ")}`;
}

/**
 * Deterministic consolidation for a tech_stack (or similar) cluster.
 * Prefer structured key-value values; resolve same-field conflicts by confidence.
 */
export function consolidateClusterDeterministic(
  clusterTopic: string,
  memories: MemoryItem[]
): ConsolidationResult {
  const conflicts: ConsolidationConflict[] = [];
  const fieldWinners = new Map<
    string,
    { item: MemoryItem; value: string; confidence: number }
 >();
  const losers: MemoryItem[] = [];

  for (const item of memories) {
    const topic = (item.topicKey || "").toLowerCase();
    // Existing consolidated record: merge its structured JSON value.
    if (topic === clusterTopic.toLowerCase()) {
      try {
        const parsed = JSON.parse(item.value || item.content || "{}") as Record<
          string,
          unknown
        >;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          for (const [field, raw] of Object.entries(parsed)) {
            const val = String(raw ?? "").trim();
            if (!val) continue;
            const conf = item.confidence || 0;
            const existing = fieldWinners.get(field);
            if (!existing || conf > existing.confidence) {
              if (existing) losers.push(existing.item);
              fieldWinners.set(field, { item, value: val, confidence: conf });
            } else {
              losers.push(item);
            }
          }
          continue;
        }
      } catch {
        // fall through to atomic handling
      }
    }

    const field = stackFieldForItem(item);
    if (!field) continue;
    const val = (item.value || item.content || "").trim();
    if (!val) continue;
    const conf = item.confidence || 0;
    const existing = fieldWinners.get(field);
    if (!existing) {
      fieldWinners.set(field, { item, value: val, confidence: conf });
      continue;
    }
    if (existing.value.toLowerCase() === val.toLowerCase()) {
      // reinforce — keep higher confidence item as winner
      if (conf > existing.confidence) {
        losers.push(existing.item);
        fieldWinners.set(field, { item, value: val, confidence: conf });
      } else {
        losers.push(item);
      }
      continue;
    }
    // Contradiction: keep higher confidence.
    const keepNew = conf > existing.confidence;
    const kept = keepNew ? item : existing.item;
    const dropped = keepNew ? existing.item : item;
    const keptVal = keepNew ? val : existing.value;
    conflicts.push({
      memory_ids: [String(existing.item.id), String(item.id)],
      description: `${field} has two values: ${existing.value} (${existing.confidence}) and ${val} (${conf})`,
      resolution: `kept ${keptVal} due to higher confidence`,
    });
    losers.push(dropped);
    fieldWinners.set(field, {
      item: kept,
      value: keptVal,
      confidence: Math.max(conf, existing.confidence),
    });
  }

  const winners = [...fieldWinners.values()].map((w) => w.item);
  // Deduplicate winners by id (one item may win multiple fields from JSON).
  const uniqueWinners = [
    ...new Map(winners.map((w) => [w.id, w])).values(),
  ];
  const structured: Record<string, string> = {};
  for (const [field, w] of fieldWinners) {
    structured[field] = w.value;
  }

  if (Object.keys(structured).length < 2) {
    return { consolidated: [], superseded_ids: [], conflicts_detected: conflicts };
  }

  const contributing = [
    ...new Map(
      [...uniqueWinners, ...losers].map((i) => [i.id, i])
    ).values(),
  ];
  const sourceIds = contributing.map((i) => String(i.id));
  const confidence = weightedConfidence(uniqueWinners);
  const importance = Math.max(
    0.95,
    ...uniqueWinners.map((i) => i.importance || 0)
  );
  const stabilityScore = Math.max(
    ...uniqueWinners.map((i) => i.stability || 0),
    0.85
  );
  const scope = clusterTopic.startsWith("user.") ? "USER" : "PROJECT";
  const subject = scope === "USER" ? "user" : "project";

  const noteParts = [
    `Merged ${Object.keys(structured).length} stack fields from ${sourceIds.length} memories.`,
  ];
  for (const c of conflicts) {
    noteParts.push(c.resolution);
  }

  const consolidated: ConsolidatedMemory = {
    type: "ARCHITECTURE",
    scope,
    subject,
    predicate: "tech_stack",
    value: structured,
    topicKey: clusterTopic,
    confidence,
    importance: Number(importance.toFixed(3)),
    stability: stabilityScoreToLabel(stabilityScore),
    sourceMemoryIds: sourceIds,
    consolidationNote: noteParts.join(" "),
  };

  return {
    consolidated: [consolidated],
    superseded_ids: sourceIds,
    conflicts_detected: conflicts,
  };
}

export function serializeConsolidatedValue(
  value: string | Record<string, unknown>
): { content: string; valueText: string } {
  if (typeof value === "string") {
    return { content: value, valueText: value };
  }
  const valueText = JSON.stringify(value);
  const content = formatStructuredContent("tech_stack", value);
  return { content, valueText };
}

/**
 * Persist consolidation: insert consolidated row(s), mark sources SUPERSEDED.
 * Returns how many items were written / superseded.
 */
export async function applyConsolidation(
  db: Database,
  userId: string,
  result: ConsolidationResult
): Promise<{ created: number; superseded: number }> {
  if (!result.consolidated.length || !result.superseded_ids.length) {
    return { created: 0, superseded: 0 };
  }

  const nowIso = new Date().toISOString();
  const sourceIds = result.superseded_ids
    .map((id) => Number(id))
    .filter((n) => Number.isFinite(n));

  let created = 0;
  const insertedIds: number[] = [];

  for (const c of result.consolidated.slice(0, MAX_CONSOLIDATED_PER_CLUSTER)) {
    const { content, valueText } = serializeConsolidatedValue(c.value);
    const firstSource = sourceIds[0] ?? null;
    const [row] = await db
      .insert(memoryItems)
      .values({
        userId,
        content,
        type: (c.type || MemoryType.ARCHITECTURE).toLowerCase(),
        topicKey: c.topicKey,
        subject: c.subject,
        predicate: c.predicate,
        value: valueText,
        scope: c.scope.toLowerCase(),
        confidence: c.confidence,
        importance: c.importance,
        stability: stabilityLabelToScore(c.stability),
        freshness: 1.0,
        informationGain: 0.9,
        sourceMessageIdsJson: JSON.stringify(c.sourceMemoryIds),
        relatedMemoryIdsJson: JSON.stringify(c.sourceMemoryIds),
        supersedesId: firstSource,
        relationship: MemoryRelationship.SUPERSEDES,
        status: MemoryStatus.ACTIVE,
        version: 1,
        validFrom: nowIso,
        createdAt: nowIso,
        updatedAt: nowIso,
      })
      .returning();
    if (row) {
      created++;
      insertedIds.push(row.id);
    }
  }

  let superseded = 0;
  if (sourceIds.length > 0) {
    const toMark = sourceIds.filter((id) => !insertedIds.includes(id));
    if (toMark.length > 0) {
      await db
        .update(memoryItems)
        .set({
          status: MemoryStatus.SUPERSEDED,
          updatedAt: nowIso,
        })
        .where(inArray(memoryItems.id, toMark));
      superseded = toMark.length;
    }
  }

  return { created, superseded };
}

/**
 * Run one consolidation pass for a user: find clusters, consolidate
 * (Memory AI when available, else deterministic), apply, bump context version.
 * Fail-open — returns zeros on error.
 */
export async function runConsolidationPass(
  db: Database,
  userId: string,
  options?: { memoryAi?: MemoryAIAdapter | null }
): Promise<{
  clusters: number;
  created: number;
  superseded: number;
}> {
  try {
    const active = await listMemoryItems(db, userId, MemoryStatus.ACTIVE);
    const clusters = findConsolidationClusters(active);
    if (clusters.length === 0) {
      return { clusters: 0, created: 0, superseded: 0 };
    }

    let created = 0;
    let superseded = 0;

    for (const cluster of clusters) {
      let result: ConsolidationResult | null = null;

      if (options?.memoryAi) {
        try {
          result = await options.memoryAi.consolidateCluster(
            cluster.topic,
            cluster.items
          );
        } catch {
          result = null;
        }
      }

      if (!result || result.consolidated.length === 0) {
        result = consolidateClusterDeterministic(cluster.topic, cluster.items);
      }

      if (!result.consolidated.length) continue;

      const applied = await applyConsolidation(db, userId, result);
      created += applied.created;
      superseded += applied.superseded;
    }

    if (created > 0) {
      await writeContextVersion(db, userId, [`consolidation:${Date.now()}`]);
    }

    return { clusters: clusters.length, created, superseded };
  } catch {
    return { clusters: 0, created: 0, superseded: 0 };
  }
}
