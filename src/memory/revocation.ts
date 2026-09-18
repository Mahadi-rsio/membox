import type { Revocation } from "../models/memory.js";

const RESET_RE =
  /^(?:the\s+|that\s+|this\s+|temporary\s+|previous\s+|old\s+)?(?<target>[\w\s/-]+?)\s+was\s+reset\b/i;

const IGNORE_RE =
  /^(?:please\s+)?ignore\s+(?:the\s+)?(?:previous|old|earlier|last)\s+(?<target>[\w\s/-]+?)\s*[.!]?$/i;

const NO_LONGER_VALID_RE =
  /^(?:the\s+|that\s+|this\s+)?(?<target>[\w\s/-]+?)\s+(?:is|are)\s+no\s+longer\s+valid\b/i;

const REVOKED_RE =
  /^(?:the\s+)?(?<target>[\w\s/-]+?)\s+has\s+been\s+revoked\b/i;

const FORGET_RE =
  /^forget\s+(?:the\s+)?(?:previous|old|earlier|last\s+)?(?<target>[\w\s/-]*?)\s*[.!]?$/i;

const COMMON_WORDS: ReadonlySet<string> = new Set([
  "was", "were", "is", "are", "has", "have", "had", "been", "reset",
  "ignored", "revoked", "the", "and", "that", "this", "its", "it",
  "from", "to", "for", "with", "now", "previous", "old", "new",
]);

const VALUE_RE =
  /(?:ignore|instead|forget)\s+(?:it\s+)?(?:the\s+)?(?:old\s+|previous\s+)?["']?(?<value>[A-Za-z0-9][A-Za-z0-9_-]{2,})["']?/gi;

function clean(text: string): string {
  return text.trim().replace(/^['"`]+|['"`]+$/g, "").replace(/[.!?]+$/, "").trim();
}

function extractValue(text: string, target: string): string {
  const targetWords = new Set(target.toLowerCase().match(/[a-z0-9]+/g) || []);
  const matches = text.matchAll(VALUE_RE);
  for (const m of matches) {
    if (m.groups && m.groups.value) {
      const val = clean(m.groups.value);
      if (!COMMON_WORDS.has(val.toLowerCase()) && !targetWords.has(val.toLowerCase())) {
        return val;
      }
    }
  }
  return "";
}

export function parseRevocation(text: string): Revocation | null {
  if (!text) return null;

  const stripped = text.trim();
  let target: string | null = null;

  for (const regex of [RESET_RE, IGNORE_RE, NO_LONGER_VALID_RE, REVOKED_RE, FORGET_RE]) {
    const m = stripped.match(regex);
    if (m && m.groups && m.groups.target) {
      target = m.groups.target.trim();
      if (target) break;
    }
  }

  if (!target) return null;

  const value = extractValue(stripped, target);
  return {
    target: clean(target),
    value,
  };
}
