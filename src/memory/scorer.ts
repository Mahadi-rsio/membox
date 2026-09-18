import { MemoryType, type CandidateMemory, type MemoryScores } from "../models/memory.js";

export const SPECULATIVE_RE =
  /\b(might|maybe|perhaps|could|possibly|probably|i think|we might|considering|not sure|unsure|tentative)\b/i;

export const DECISION_MARKERS =
  /\b(decided|decision|we will|we'll|we are using|we're using|chose|chosen|switched to|use .+ for)\b/i;

export const CORRECTION_MARKERS =
  /\b(actually|correction|not\b.+\bbut\b|instead of|no longer|changed (to|from)|switch(?:ed)? to)\b/i;

export const TYPE_IMPORTANCE: Record<MemoryType, number> = {
  [MemoryType.DECISION]: 0.9,
  [MemoryType.CONSTRAINT]: 0.88,
  [MemoryType.GOAL]: 0.8,
  [MemoryType.ARCHITECTURE]: 0.82,
  [MemoryType.PREFERENCE]: 0.7,
  [MemoryType.FACT]: 0.65,
  [MemoryType.IMPORTANT_EVENT]: 0.75,
  [MemoryType.ACTIVE_TASK]: 0.72,
  [MemoryType.TEMPORARY_STATE]: 0.3,
};

export function looksSpeculative(text: string): boolean {
  return SPECULATIVE_RE.test(text);
}

export function looksLikeCorrection(text: string): boolean {
  return CORRECTION_MARKERS.test(text);
}

export function contentSimilarity(a: string, b: string): number {
  const sa = a.toLowerCase().trim();
  const sb = b.toLowerCase().trim();
  if (sa === sb) return 1.0;
  if (!sa || !sb) return 0.0;

  const m = sa.length;
  const n = sb.length;
  const dp: number[] = new Array(n + 1).fill(0);

  for (let i = 1; i <= m; i++) {
    let prev = 0;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      if (sa[i - 1] === sb[j - 1]) {
        dp[j] = prev + 1;
      } else {
        dp[j] = Math.max(dp[j], dp[j - 1]);
      }
      prev = temp;
    }
  }

  const lcs = dp[n];
  return (2.0 * lcs) / (m + n);
}

function computeInformationGain(content: string, existing: string[]): number {
  if (!existing || existing.length === 0) {
    return 0.85;
  }
  let best = 0.0;
  for (const other of existing) {
    const sim = contentSimilarity(content, other);
    if (sim > best) best = sim;
  }
  if (best >= 0.92) {
    return 0.05; // near duplicate
  }
  if (best >= 0.75) {
    return 0.25; // soft update
  }
  return 0.8; // new information
}

export const INFO_GAIN_WRITE_THRESHOLD = 0.15;

export function shouldWriteNewItem(scores: MemoryScores): boolean {
  return scores.informationGain >= INFO_GAIN_WRITE_THRESHOLD;
}

export function scoreCandidate(
  candidate: CandidateMemory,
  existingContents?: string[]
): MemoryScores {
  const text = candidate.content;
  const speculative = looksSpeculative(text) || candidate.authority === "speculation";
  const userAuthority = candidate.authority === "user" && !speculative;

  let confidence = 0.55;
  if (candidate.type === MemoryType.DECISION && userAuthority) {
    confidence = 0.95;
  } else if (userAuthority) {
    confidence = 0.88;
  } else if (candidate.authority === "assistant" && !speculative) {
    confidence = 0.7;
  }

  if (speculative) {
    confidence = Math.min(confidence, 0.6);
  }

  if (candidate.isCorrection || looksLikeCorrection(text)) {
    confidence = Math.max(confidence, 0.92);
  }

  if (DECISION_MARKERS.test(text) && userAuthority) {
    confidence = Math.max(confidence, 0.93);
  }

  let importance = TYPE_IMPORTANCE[candidate.type] ?? 0.6;
  if (candidate.isCorrection) {
    importance = Math.max(importance, 0.9);
  }

  let stability = userAuthority ? 0.55 : 0.35;
  if (speculative) {
    stability = Math.min(stability, 0.3);
  }

  const freshness = 1.0;
  const infoGain = computeInformationGain(text, existingContents || []);

  return {
    confidence: Number(confidence.toFixed(3)),
    importance: Number(importance.toFixed(3)),
    stability: Number(stability.toFixed(3)),
    freshness,
    informationGain: Number(infoGain.toFixed(3)),
  };
}
