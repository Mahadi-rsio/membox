import { estimateMessageTokens, estimateTokens } from "./tokens.js";
import { isLowInfoMessage, normalizeUtterance, LOW_INFO_PHRASES } from "../memory/low-info.js";
import { DECISION_MARKERS } from "../memory/scorer.js";
import type { MemoryItem } from "../db/schema/memory.js";

const WORD_RE = /\w+/gu;

const STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "else", "when", "at", "by",
  "for", "with", "about", "against", "between", "into", "through", "during", "before",
  "after", "above", "below", "to", "from", "up", "down", "in", "out", "on", "off",
  "over", "under", "again", "further", "then", "once", "here", "there", "all", "any",
  "both", "each", "few", "more", "most", "other", "some", "such", "no", "nor", "not",
  "only", "own", "same", "so", "than", "too", "very", "s", "t", "can", "will", "just",
  "don", "should", "now", "i", "me", "my", "we", "our", "you", "your", "he", "she",
  "it", "they", "them", "what", "which", "who", "whom", "where", "this", "that", "these", "those",
  "am", "is", "are", "was", "were", "be", "been", "being", "have", "has", "had", "having",
  "do", "does", "did", "doing",
]);

export function extractKeywords(text: string): Set<string> {
  const normalized = text
    .toLowerCase()
    .replace(/\bfavourite\b/g, "favorite")
    .replace(/\bcolour\b/g, "color")
    .replace(/\borganise\b/g, "organize");
  const words = normalized.match(WORD_RE) || [];
  return new Set(words.filter((w) => w.length > 2 && !STOPWORDS.has(w)));
}

export function computeRelevance(text: string, queryKeywords: Set<string>): number {
  if (queryKeywords.size === 0) {
    return 0.5;
  }
  const itemKeywords = extractKeywords(text);
  if (itemKeywords.size === 0) {
    return 0.3;
  }
  let overlap = 0;
  for (const k of queryKeywords) {
    if (itemKeywords.has(k)) {
      overlap++;
    }
  }
  if (overlap === 0) {
    return 0.25;
  }
  const ratio = overlap / queryKeywords.size;
  return Math.min(1.0, 0.4 + ratio * 0.6);
}

export interface SelectableItem {
  itemId: string;
  kind: "system" | "canonical_memory" | "message" | "tool_result" | "new_message";
  content: string;
  tokenCost: number;
  rawMessage?: Record<string, any> | null;
  memoryItem?: MemoryItem | null;
  ordinal: number;
  mandatory: boolean;

  relevance: number;
  confidence: number;
  importance: number;
  freshness: number;
  stability: number;
  informationGain: number;

  value: number;
  selectionScore: number;
}

export function createSelectableItem(params: {
  itemId: string;
  kind: "system" | "canonical_memory" | "message" | "tool_result" | "new_message";
  content: string;
  tokenCost: number;
  rawMessage?: Record<string, any> | null;
  memoryItem?: MemoryItem | null;
  ordinal: number;
  mandatory?: boolean;
  relevance?: number;
  confidence?: number;
  importance?: number;
  freshness?: number;
  stability?: number;
  informationGain?: number;
}): SelectableItem {
  const relevance = params.relevance ?? 0.5;
  const confidence = params.confidence ?? 0.5;
  const importance = params.importance ?? 0.5;
  const freshness = params.freshness ?? 0.5;
  const stability = params.stability ?? 0.5;
  const informationGain = params.informationGain ?? 0.5;

  const score =
    0.25 * relevance +
    0.25 * importance +
    0.2 * freshness +
    0.1 * confidence +
    0.1 * stability +
    0.1 * informationGain;

  const value = Number(Math.min(1.0, Math.max(0.0, score)).toFixed(4));
  const selectionScore = value / Math.max(1, params.tokenCost);

  return {
    itemId: params.itemId,
    kind: params.kind,
    content: params.content,
    tokenCost: params.tokenCost,
    rawMessage: params.rawMessage,
    memoryItem: params.memoryItem,
    ordinal: params.ordinal,
    mandatory: params.mandatory ?? false,
    relevance,
    confidence,
    importance,
    freshness,
    stability,
    informationGain,
    value,
    selectionScore,
  };
}

export function scoreMessageItem(
  message: Record<string, any>,
  options: {
    index: number;
    totalMessages: number;
    queryKeywords: Set<string>;
    isLatest?: boolean;
  }
): SelectableItem {
  const role = message.role || "user";
  const content = String(message.content || "");
  const tokens = estimateMessageTokens(message);

  if (role === "system") {
    return createSelectableItem({
      itemId: `msg-${options.index}`,
      kind: "system",
      content,
      tokenCost: tokens,
      rawMessage: message,
      ordinal: options.index,
      mandatory: true,
      relevance: 0.8,
      confidence: 1.0,
      importance: 1.0,
      freshness: 1.0,
      stability: 1.0,
      informationGain: 0.9,
    });
  }

  if (options.isLatest) {
    return createSelectableItem({
      itemId: `msg-${options.index}`,
      kind: "new_message",
      content,
      tokenCost: tokens,
      rawMessage: message,
      ordinal: options.index,
      mandatory: true,
      relevance: 1.0,
      confidence: 1.0,
      importance: 1.0,
      freshness: 1.0,
      stability: 0.9,
      informationGain: 0.95,
    });
  }

  const turnsFromEnd = options.totalMessages - 1 - options.index;
  const freshness = Math.max(0.2, 1.0 - turnsFromEnd * 0.08);
  const lowInfo = isLowInfoMessage(content, role);

  let kind: "message" | "tool_result" = "message";
  let importance = 0.5;
  let stability = role === "user" ? 0.8 : 0.65;
  let confidence = role === "user" ? 0.95 : 0.8;

  if (role === "tool") {
    kind = "tool_result";
    importance = turnsFromEnd <= 2 ? 0.65 : 0.4;
    stability = 0.7;
    confidence = 0.9;
  } else {
    importance = turnsFromEnd <= 3 ? 0.85 : 0.5;
  }

  const norm = normalizeUtterance(content);
  const isAck =
    lowInfo ||
    LOW_INFO_PHRASES.has(norm) ||
    (norm ? norm.split(" ").every((w) => LOW_INFO_PHRASES.has(w)) : true);

  if (DECISION_MARKERS.test(content)) {
    importance = Math.max(importance, 0.92);
    stability = Math.max(stability, 0.9);
  }

  let informationGain = turnsFromEnd <= 2 ? 0.85 : 0.6;
  if (isAck) {
    importance = 0.05;
    informationGain = 0.05;
    stability = 0.1;
  }

  const relevance = computeRelevance(content, options.queryKeywords);

  return createSelectableItem({
    itemId: `msg-${options.index}`,
    kind,
    content,
    tokenCost: tokens,
    rawMessage: message,
    ordinal: options.index,
    mandatory: false,
    relevance,
    confidence,
    importance,
    freshness,
    stability,
    informationGain,
  });
}

export function scoreCanonicalItem(
  item: MemoryItem,
  options: {
    ordinal: number;
    queryKeywords: Set<string>;
  }
): SelectableItem {
  const tokens = estimateTokens(`${item.type}: ${item.content}`) + 2;
  let relevance = computeRelevance(item.content, options.queryKeywords);

  // Boost relevance using the structured topicKey (e.g. "project.database",
  // "user.name"). The attribute segment often matches the query noun even when
  // the phrasing differs ("what database does it use?" -> "database").
  if (item.topicKey) {
    const keyTerms = extractKeywords(item.topicKey.replace(/[._-]/g, " "));
    const keyRelevance = computeRelevance(item.topicKey, options.queryKeywords);
    const keyOverlap = [...options.queryKeywords].filter((k) => keyTerms.has(k)).length;
    const structuredBonus = keyOverlap > 0 ? keyRelevance : 0;
    relevance = Math.max(relevance, Math.min(1.0, 0.5 + structuredBonus * 0.5));
  }

  // Durable user identity / preferences should survive multi-hop prompts even
  // when the question nouns don't lexical-match (e.g. "coding style" vs "verbose").
  const scope = (item.scope || "").toLowerCase();
  const type = (item.type || "").toLowerCase();
  const isDurableUser =
    scope === "user" &&
    (type === "preference" || type === "fact" || type === "constraint");
  if (isDurableUser) {
    relevance = Math.max(relevance, 0.55);
  }

  // Historical (superseded) items are only injected for contrast questions;
  // keep them selectable but slightly below active peers.
  if ((item.status || "").toLowerCase() === "superseded") {
    relevance = Math.max(0.35, relevance * 0.85);
  }

  return createSelectableItem({
    itemId: `mem-${item.id || options.ordinal}`,
    kind: "canonical_memory",
    content: item.content,
    tokenCost: tokens,
    memoryItem: item,
    ordinal: options.ordinal,
    // Keep a small set of durable user facts always in context.
    mandatory: isDurableUser && (item.status || "active") === "active",
    relevance,
    confidence: item.confidence || 0.85,
    importance: item.importance || 0.8,
    freshness: item.freshness || 0.9,
    stability: item.stability || 0.8,
    informationGain: item.informationGain || 0.75,
  });
}

function solveKnapsack(items: SelectableItem[], capacity: number): SelectableItem[] {
  if (!items || items.length === 0 || capacity <= 0) {
    return [];
  }

  const totalW = items.reduce((acc, x) => acc + x.tokenCost, 0);
  if (totalW <= capacity) {
    return [...items];
  }

  // 0/1 Knapsack DP
  if (capacity * items.length <= 400000) {
    const n = items.length;
    const dp = new Float64Array(capacity + 1);
    const keep: boolean[][] = Array.from({ length: n }, () => new Array(capacity + 1).fill(false));

    for (let i = 0; i < n; i++) {
      const w = items[i].tokenCost;
      const v = items[i].value;
      if (w > capacity) continue;

      for (let cap = capacity; cap >= w; cap--) {
        if (dp[cap - w] + v > dp[cap]) {
          dp[cap] = dp[cap - w] + v;
          keep[i][cap] = true;
        }
      }
    }

    const selected: SelectableItem[] = [];
    let currCap = capacity;
    for (let i = n - 1; i >= 0; i--) {
      if (keep[i][currCap]) {
        selected.push(items[i]);
        currCap -= items[i].tokenCost;
      }
    }
    return selected;
  }

  // Greedy fallback for very large budgets
  const sorted = [...items].sort((a, b) => b.selectionScore - a.selectionScore);
  const chosen: SelectableItem[] = [];
  let rem = capacity;
  for (const item of sorted) {
    if (item.tokenCost <= rem) {
      chosen.push(item);
      rem -= item.tokenCost;
    }
  }
  return chosen;
}

export function selectItemsForBudget(
  candidates: SelectableItem[],
  budget: number
): SelectableItem[] {
  const mandatory = candidates.filter((c) => c.mandatory);
  const optional = candidates.filter((c) => !c.mandatory);

  const mandatoryTokens = mandatory.reduce((acc, m) => acc + m.tokenCost, 0);
  const remainingBudget = budget - mandatoryTokens;

  const selected = [...mandatory];
  if (remainingBudget <= 0) {
    selected.sort((a, b) => a.ordinal - b.ordinal);
    return selected;
  }

  const chosenOptional = solveKnapsack(optional, remainingBudget);
  selected.push(...chosenOptional);
  selected.sort((a, b) => a.ordinal - b.ordinal);
  return selected;
}
