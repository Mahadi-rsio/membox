import type { Correction } from "../models/memory.js";

const CORRECTION_PREFIX_RE =
  /^\s*(?:actually[,:]?\s+|correction[,:]?\s+|no[,:]?\s+|wait[,:]?\s+|on\s+second\s+thought[,:]?\s+|to\s+clarify[,:]?\s+|i\s+meant[,:]?\s+|let\s+me\s+correct\s+that[,:]?\s+|scratch\s+that[,:]?\s+)/i;

const CHANGED_FROM_TO_RE =
  /^(?:the\s+)?(?<target>[A-Za-z][\w\s/-]{0,30}?)\s+changed\s+from\s+(?<old>.+?)\s+to\s+(?<new>.+?)\s*[.!]?$/i;

const USES_INSTEAD_OF_RE =
  /^(?:the\s+)?(?<target>[A-Za-z][\w\s/-]{0,30}?)\s+(?:now\s+)?uses\s+(?<new>.+?)\s+instead\s+of\s+(?<old>.+?)\s*[.!]?$/i;

const WAS_CHANGED_TO_RE =
  /^the\s+(?<target>[A-Za-z][\w\s/-]{0,30}?)\s+was\s+changed\s+to\s+(?<new>.+?)\s*[.!]?$/i;

const I_CHANGED_FROM_TO_RE =
  /^i\s+changed\s+(?:my\s+)?(?<target>[A-Za-z][\w\s/-]{0,30}?)\s+from\s+(?<old>.+?)\s+to\s+(?<new>.+?)\s*[.!]?$/i;

const TARGET_CHANGED_TO_RE =
  /^the\s+(?<target>[A-Za-z][\w\s/-]{0,30}?)\s+changed\s+to\s+(?<new>.+?)\s*[.!]?$/i;

function clean(text: string): string {
  return text.trim().replace(/^['"`]+|['"`]+$/g, "").replace(/[.!?]+$/, "").trim();
}

export function stripCorrectionPrefix(text: string): [string, boolean] {
  const m = text.match(CORRECTION_PREFIX_RE);
  if (!m) {
    return [text, false];
  }
  return [text.slice(m[0].length).trim(), true];
}

export function parseCorrection(text: string): Correction | null {
  if (!text) return null;

  let m = text.match(CHANGED_FROM_TO_RE);
  if (m && m.groups) {
    return {
      target: clean(m.groups.target),
      oldValue: clean(m.groups.old),
      newValue: clean(m.groups.new),
    };
  }

  m = text.match(USES_INSTEAD_OF_RE);
  if (m && m.groups) {
    return {
      target: clean(m.groups.target),
      oldValue: clean(m.groups.old),
      newValue: clean(m.groups.new),
    };
  }

  m = text.match(I_CHANGED_FROM_TO_RE);
  if (m && m.groups) {
    return {
      target: clean(m.groups.target),
      oldValue: clean(m.groups.old),
      newValue: clean(m.groups.new),
    };
  }

  m = text.match(WAS_CHANGED_TO_RE);
  if (m && m.groups) {
    return {
      target: clean(m.groups.target),
      oldValue: "",
      newValue: clean(m.groups.new),
    };
  }

  m = text.match(TARGET_CHANGED_TO_RE);
  if (m && m.groups) {
    return {
      target: clean(m.groups.target),
      oldValue: "",
      newValue: clean(m.groups.new),
    };
  }

  return null;
}
