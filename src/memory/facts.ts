import Groq from "groq-sdk";
import type { ChatCompletionMessageParam } from "groq-sdk/resources/chat/completions";
import { MemoryType, type StructuredFact, FactState } from "../models/memory.js";
import { isInterrogative } from "./interrogative.js";
import { info, warn, debug } from "../log.js";

// ============================================================
// 1. EXISTING EXPORTS — preserved exactly for backward compat
// ============================================================

export function slugify(text: string): string {
  const parts = text.toLowerCase().match(/[a-z0-9]+/g) || [];
  return parts.slice(0, 6).join("_") || "item";
}

export function cleanVal(val: string): string {
  let v = val.trim().replace(/^['"`]+|['"`]+$/g, "");
  v = v.replace(/[.!?]+$/, "").trim();
  return v;
}

export const INVALID_KEYS: ReadonlySet<string> = new Set([
  "what", "when", "where", "which", "who", "whom", "whose", "why", "how",
  "is", "are", "was", "were", "do", "does", "did", "can", "could", "will",
  "would", "should", "shall", "have", "has", "had", "may", "might",
]);

const DB_KEYWORDS = new Set([
  "postgres", "postgresql", "mysql", "mariadb", "sqlite", "mongodb", "mongo",
  "redis", "valkey", "dynamodb", "d1", "turso", "libsql", "neon", "supabase",
  "planetscale", "cockroachdb", "cockroach", "pglite", "pinecone", "weaviate",
  "qdrant", "milvus", "faiss", "elasticsearch", "opensearch", "clickhouse",
  "upstash", "database", "db",
]);

const UI_KEYWORDS = new Set([
  "tailwind", "mui", "shadcn", "bootstrap", "chakra", "antd",
]);

const FRONTEND_KEYWORDS = new Set([
  "react", "next", "next.js", "vue", "nuxt", "svelte", "sveltekit", "astro",
  "solid", "angular", "remix", "tanstack", "tanstack start",
]);

const LANGUAGE_KEYWORDS = new Set([
  "typescript", "javascript", "python", "go", "golang", "rust", "java",
  "kotlin", "swift", "c", "c++", "csharp", "php", "ruby", "dart", "lua",
]);

const THEME_KEYWORDS = new Set([
  "dark", "light", "dark mode", "light mode", "dark theme", "light theme",
]);

const WORKFLOW_KEYWORDS = new Set([
  "agile", "scrum", "kanban", "waterfall", "sprint", "workflow",
]);

const RUNTIME_KEYWORDS = new Set([
  "cloudflare", "workers", "deno", "node", "nodejs", "bun", "lambda",
  "vercel", "netlify", "edge",
]);

const FRAMEWORK_KEYWORDS = new Set([
  "hono", "express", "fastify", "flask", "django", "fastapi", "spring",
  "laravel", "elysia", "bun", "node", "node.js", "deno",
]);

const COLOR_KEYWORDS = new Set([
  "red", "blue", "green", "yellow", "orange", "purple", "pink", "black",
  "white", "gray", "grey", "brown", "cyan", "magenta", "violet", "indigo",
  "teal", "navy", "maroon", "beige", "gold", "silver",
]);

export const PREFERENCE_NOISE_VALUES: ReadonlySet<string> = new Set([
  "this", "that", "these", "those", "it", "response", "answer", "reply",
  "message", "error", "bug", "result", "output", "suggestion", "idea",
  "solution", "explanation",
]);

const TEMPORAL_TRAILING_RE =
  /\s+(?:now|these\s+days|anymore|lately|currently|today|recently)\s*$/i;

function setIntersect<T>(a: Set<T>, b: Set<T>): boolean {
  for (const item of a) {
    if (b.has(item)) return true;
  }
  return false;
}

export function normalizePreferenceSpelling(text: string): string {
  return text
    .toLowerCase()
    .replace(/\bfavourite\b/g, "favorite")
    .replace(/\bcolour\b/g, "color")
    .replace(/\borganise\b/g, "organize");
}

export function isPreferenceNoiseValue(value: string): boolean {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/^(?:a|an|the)\s+/, "")
    .replace(/[.!?]+$/, "")
    .trim();
  if (!cleaned) return true;
  const words = cleaned.match(/[a-z0-9+#.-]+/g) || [];
  if (words.length === 0) return true;
  if (words.some((w) => INVALID_KEYS.has(w))) return true;
  if (["this", "that", "these", "those", "it"].includes(words[0]!)) return true;
  if (words.every((w) => PREFERENCE_NOISE_VALUES.has(w))) return true;
  return false;
}

export function detectPreferenceDomain(
  choice: string,
  other = ""
): [string, string] {
  const combined = normalizePreferenceSpelling(`${choice} ${other}`);
  const words = new Set(combined.match(/[a-z0-9+#.-]+/g) || []);

  if (
    setIntersect(words, UI_KEYWORDS) ||
    combined.includes("ui library") ||
    words.has("ui")
  ) {
    return ["ui_library", "preference:ui_library"];
  }
  if (
    setIntersect(words, FRONTEND_KEYWORDS) ||
    combined.includes("frontend") ||
    combined.includes("framework")
  ) {
    return ["frontend_framework", "preference:frontend_framework"];
  }
  if (setIntersect(words, LANGUAGE_KEYWORDS) || combined.includes("language")) {
    return ["language", "preference:language"];
  }
  if (
    setIntersect(words, THEME_KEYWORDS) ||
    combined.includes("theme") ||
    combined.includes("mode")
  ) {
    return ["theme", "preference:theme"];
  }
  if (
    setIntersect(words, DB_KEYWORDS) ||
    combined.includes("database") ||
    combined.includes("db")
  ) {
    return ["database", "preference:database"];
  }
  if (setIntersect(words, WORKFLOW_KEYWORDS)) {
    return ["workflow", "preference:workflow"];
  }
  if (
    setIntersect(words, RUNTIME_KEYWORDS) ||
    combined.includes("runtime") ||
    combined.includes("cloudflare workers")
  ) {
    return ["runtime", "preference:runtime"];
  }
  if (setIntersect(words, FRAMEWORK_KEYWORDS) || combined.includes("framework")) {
    return ["framework", "preference:framework"];
  }
  if (
    setIntersect(words, COLOR_KEYWORDS) ||
    words.has("color")
  ) {
    return ["favorite_color", "preference:favorite_color"];
  }

  const cSlug = slugify(choice);
  return ["preference", `preference:${cSlug}`];
}

export function scopeForFact(fact: StructuredFact): "user" | "project" | "session" {
  if (fact.scope) return fact.scope;
  const entity = fact.entity.toLowerCase();
  if (entity === "user" || entity === "my") return "user";
  if (fact.key && /^session\./i.test(fact.key)) return "session";
  return "project";
}

export function deriveFactKey(fact: StructuredFact): string {
  if (fact.key) return fact.key;
  const scope = scopeForFact(fact);
  if (fact.attribute === "project") {
    return "project.name";
  }
  const attr = slugify(fact.attribute);
  return `${scope}.${attr}`;
}

export function structuredFactToContent(fact: StructuredFact): string {
  if (fact.memoryType === MemoryType.PREFERENCE) {
    return fact.value;
  }
  if (fact.attribute === "project") {
    return `Project: ${fact.value}`;
  }
  const attrTitle = fact.attribute
    ? fact.attribute[0].toUpperCase() + fact.attribute.slice(1).replace(/_/g, " ")
    : "Item";
  return `${attrTitle}: ${fact.value}`;
}

export function structuredFactToTopicKey(fact: StructuredFact): string {
  if (fact.memoryType === MemoryType.PREFERENCE) {
    const attr = normalizePreferenceSpelling(fact.attribute || "");
    if (
      attr.startsWith("disliked_") ||
      attr.startsWith("favorite_") ||
      attr.startsWith("preferred_")
    ) {
      return `preference:${slugify(attr)}`;
    }
    if (attr && attr !== "preference") {
      return `preference:${slugify(attr)}`;
    }
    const [, topic] = detectPreferenceDomain(fact.value);
    return topic;
  }
  if (fact.attribute === "project") {
    return "project.name";
  }
  return deriveFactKey(fact);
}

// ============================================================
// 2. EXISTING EXTRACTORS — preserved for backward compat
// ============================================================

const BUILDING_RE =
  /^\s*(?:i\s+am|i'm|we\s+are|we're|building)\s+(?:building\s+)?(?<val>.+?)\s*[.!?]?$/i;

export function extractBuilding(text: string): StructuredFact | null {
  const m = text.match(BUILDING_RE);
  if (!m || !m.groups) return null;
  const val = cleanVal(m.groups.val);
  if (!val || INVALID_KEYS.has(val.toLowerCase())) return null;

  const calledMatch = val.match(/\bcalled\s+([A-Za-z0-9_-]+)/i);
  const projectName = calledMatch ? calledMatch[1] : val;

  return {
    entity: projectName,
    attribute: "project",
    value: projectName,
    memoryType: MemoryType.FACT,
    rawText: text,
    key: "project.name",
    scope: "project",
  };
}

const USES_RE =
  /^\s*(?:the\s+)?(?<entity>[A-Za-z][\w\s/-]{0,30}?)\s+(?:uses|is\s+using|will\s+use)\s+(?<val>.+?)\s*[.!?]?$/i;

const LOCATION_RE =
  /^\s*(?:i\s+live|i\s+stay|i'm\s+based)\s+in\s+(?<val>.+?)\s*[.!?]?$/i;
const FROM_LOCATION_RE =
  /^\s*(?:i\s+am\s+from|i'm\s+from)\s+(?<val>.+?)\s*[.!?]?$/i;

export function extractLocation(text: string): StructuredFact | null {
  const cleaned = text.trim();
  const m = cleaned.match(LOCATION_RE) || cleaned.match(FROM_LOCATION_RE);
  if (!m || !m.groups?.val) return null;
  const val = cleanVal(m.groups.val);
  if (!val || INVALID_KEYS.has(val.toLowerCase())) return null;
  return {
    entity: "user",
    attribute: "location",
    value: val,
    memoryType: MemoryType.FACT,
    rawText: text,
    key: "user.location",
    scope: "user",
    state: "current",
    confidence: 1.0,
  };
}

export function extractUses(text: string): StructuredFact | null {
  const m = text.match(USES_RE);
  if (!m || !m.groups) return null;
  const entity = m.groups.entity.trim();
  const val = cleanVal(m.groups.val);
  if (!entity || !val || INVALID_KEYS.has(entity.toLowerCase())) return null;

  const entityClean = entity.toLowerCase().startsWith("the ") ? entity.slice(4).trim() : entity;

  const forMatch = val.match(/^(.+?)\s+for\s+(.+)$/i);
  const purpose = forMatch ? forMatch[2].trim() : "";

  const valLower = val.toLowerCase();
  const words = new Set(valLower.match(/[a-z0-9+#.-]+/g) || []);

  let attr = "technology";
  let mtype = MemoryType.FACT;

  if (purpose && !/\b(project|production|staging|dev|testing)\b/i.test(purpose)) {
    attr = attributeForPurpose(purpose) ?? slugify(purpose);
    mtype = MemoryType.DECISION;
  } else if (attributeForValue(valLower) !== "technology") {
    attr = attributeForValue(valLower);
    mtype = MemoryType.DECISION;
  } else if (setIntersect(words, UI_KEYWORDS)) {
    attr = "ui_library";
    mtype = MemoryType.DECISION;
  } else if (setIntersect(words, FRONTEND_KEYWORDS)) {
    attr = "frontend";
    mtype = MemoryType.DECISION;
  } else if (setIntersect(words, WORKFLOW_KEYWORDS)) {
    attr = "workflow";
    mtype = MemoryType.FACT;
  } else {
    attr = entityClean.toLowerCase() === "team" ? "workflow" : "technology";
    mtype = MemoryType.FACT;
  }

  const entityKey = entityClean.toLowerCase();
  const scope: "user" | "project" =
    entityKey === "user" || entityKey === "my" ? "user" : "project";

  return {
    entity: entityClean,
    attribute: attr,
    value: val,
    memoryType: mtype,
    rawText: text,
    key: `${scope}.${slugify(attr)}`,
    scope,
  };
}

const POSSESSIVE_RE =
  /^\s*(?<entity>[A-Za-z][\w\s/-]{0,30}?)'s\s+(?<attr>[A-Za-z][\w\s/-]{0,30}?)\s+(?:is|are|was|will\s+be|has\s+been|scheduled\s+for)\s+(?<val>.+?)\s*[.!?]?$/i;

export function extractPossessive(text: string): StructuredFact | null {
  const m = text.match(POSSESSIVE_RE);
  if (!m || !m.groups) return null;
  const entity = m.groups.entity.trim();
  const attr = m.groups.attr.trim();
  const val = cleanVal(m.groups.val);
  if (!entity || !attr || !val) return null;
  if (INVALID_KEYS.has(entity.toLowerCase()) || INVALID_KEYS.has(attr.toLowerCase())) return null;

  const attrLower = attr.toLowerCase();
  let mtype = MemoryType.FACT;
  if (attrLower.includes("architecture") || attrLower.includes("design")) {
    mtype = MemoryType.ARCHITECTURE;
  } else if (attrLower.includes("goal") || attrLower.includes("objective")) {
    mtype = MemoryType.GOAL;
  }

  const scope = entity.toLowerCase() === "user" ? "user" : "project";
  return {
    entity,
    attribute: attr,
    value: val,
    memoryType: mtype,
    rawText: text,
    key: `${scope}.${slugify(attr)}`,
    scope,
  };
}

const PREFER_RE =
  /^\s*(?:i\s+)?(?:prefer|would\s+rather|preference)\b[:\s-]*(?<choice>.+?)(?:\s+over\s+(?<other>.+?)|\s+than\s+(?<than>.+?))?\s*[.!?]?$/i;

export function extractPreference(text: string): StructuredFact | null {
  const m = text.match(PREFER_RE);
  if (!m || !m.groups) return null;
  let choice = cleanVal(m.groups.choice);
  const other = cleanVal(m.groups.other || m.groups.than || "");
  if (!choice || INVALID_KEYS.has(choice.toLowerCase())) return null;

  if (choice.toLowerCase().startsWith("use ")) {
    choice = choice.slice(4).trim();
  }

  const [attr] = detectPreferenceDomain(choice, other);

  return {
    entity: "user",
    attribute: attr,
    value: choice,
    memoryType: MemoryType.PREFERENCE,
    rawText: text,
    key: `user.preference.${slugify(attr)}`,
    scope: "user",
    metadata: other ? { preferred_over: other } : undefined,
  };
}

const FAVORITE_IS_RE =
  /^\s*(?:my\s+)?(?<kind>favorite|favourite|preferred)\s+(?<attr>[A-Za-z][\w\s/-]{0,30}?)\s+(?:is|are|=|:)\s+(?<val>.+?)\s*[.!?]?$/i;

export function extractFavoriteIs(text: string): StructuredFact | null {
  const m = text.match(FAVORITE_IS_RE);
  if (!m || !m.groups) return null;

  const kindRaw = m.groups.kind.toLowerCase();
  const kind = kindRaw === "favourite" ? "favorite" : kindRaw === "preferred" ? "preferred" : "favorite";
  let attr = normalizePreferenceSpelling(m.groups.attr.trim());
  attr = slugify(attr);
  if (!attr || INVALID_KEYS.has(attr)) return null;

  let val = cleanVal(m.groups.val);
  val = val.replace(TEMPORAL_TRAILING_RE, "").trim();
  if (!val || isPreferenceNoiseValue(val)) return null;

  const predicate = `${kind}_${attr}`;
  return {
    entity: "user",
    attribute: predicate,
    value: val,
    memoryType: MemoryType.PREFERENCE,
    rawText: text,
    key: `user.${predicate}`,
    scope: "user",
  };
}

const AFFECT_PREF_RE =
  /^\s*i\s+(?:(?:do\s+not|don't|dont)\s+(?:really\s+)?(?<negVerb>like|love|enjoy|prefer)|(?:really\s+)?(?<verb>love|like|enjoy|adore|hate|dislike))\s+(?<val>.+?)\s*[.!?]?$/i;

export function extractAffectPreference(text: string): StructuredFact | null {
  const m = text.match(AFFECT_PREF_RE);
  if (!m || !m.groups) return null;

  const negVerb = m.groups.negVerb?.toLowerCase();
  const verb = (m.groups.verb || negVerb || "").toLowerCase();
  const isNegative = Boolean(negVerb) || verb === "hate" || verb === "dislike";

  let val = cleanVal(m.groups.val);
  val = val.replace(TEMPORAL_TRAILING_RE, "").trim();
  val = val.replace(/^(?:a|an|the)\s+/i, "").trim();
  if (!val || isPreferenceNoiseValue(val)) return null;

  const [domain] = detectPreferenceDomain(val);
  let attribute: string;
  if (isNegative) {
    const base =
      domain === "favorite_color"
        ? "color"
        : domain === "preference"
          ? slugify(val)
          : domain;
    attribute = `disliked_${base}`;
  } else if (domain === "favorite_color") {
    attribute = "favorite_color";
  } else if (domain === "preference") {
    attribute = slugify(val);
  } else {
    attribute = domain;
  }

  return {
    entity: "user",
    attribute,
    value: val,
    memoryType: MemoryType.PREFERENCE,
    rawText: text,
    key: `user.${attribute}`,
    scope: "user",
  };
}

const THE_Y_IS_X_RE =
  /^\s*(?:(?:temporary\s+detail|note|detail)\s*[:\s-]\s*)?(?:the\s+|my\s+)?(?<attr>[A-Za-z][\w\s/-]{0,35}?)\s*(?:=| is | are | was | will\s+be |:=|:)\s*(?<val>.+?)\s*[.!?]?$/i;

export function extractTheYIsX(text: string): StructuredFact | null {
  const m = text.match(THE_Y_IS_X_RE);
  if (!m || !m.groups) return null;
  let attr = m.groups.attr.trim();
  const val = cleanVal(m.groups.val);
  if (!attr || !val || val.endsWith("?")) return null;
  if (INVALID_KEYS.has(attr.toLowerCase())) return null;

  const attrLower = attr.toLowerCase();
  const words = new Set(attrLower.match(/[a-z0-9+#.-]+/g) || []);

  let mtype = MemoryType.FACT;
  if (/\b(target|deployment|database|db|provider|stack|hosting)\b/i.test(attrLower)) {
    mtype = MemoryType.DECISION;
  } else if (words.has("architecture") || words.has("design")) {
    mtype = MemoryType.ARCHITECTURE;
  } else if (words.has("goal") || words.has("objective")) {
    mtype = MemoryType.GOAL;
  } else if (words.has("preference") || words.has("prefer")) {
    mtype = MemoryType.PREFERENCE;
  }

  let entity = attr;
  if (text.trim().toLowerCase().startsWith("my name")) {
    entity = "user";
    attr = "name";
  }

  const scope = entity.toLowerCase() === "user" ? "user" : "project";
  return {
    entity,
    attribute: attr,
    value: val,
    memoryType: mtype,
    rawText: text,
    key: `${scope}.${slugify(attr)}`,
    scope,
  };
}

const RUNTIME_RE =
  /\b(cloudflare workers|cloudflare|workers|deno|node|nodejs|bun|lambda|aws lambda|vercel|netlify|edge)\b/i;
const FRAMEWORK_RE =
  /\b(hono|next|nextjs|express|fastify|nuxt|sveltekit|flask|django|spring|rails|fastapi)\b/i;
const CACHE_RE = /\b(upstash|redis|memcached|cloudflare kv|kv store|cache)\b/i;
const STORAGE_RE = /\b(cloudflare r2|r2|s3|gcs|azure blob|minio|object storage|storage)\b/i;
const EMBEDDING_RE = /\b(embedding|embeddings|pgvector|vector|semantic retrieval|semantic)\b/i;
const LLM_RE = /\b(groq|openai|anthropic|claude|gpt|llama|mistral|gemini|mixtral|summariz)\b/i;
const DATABASE_RE =
  /\b(turso|neon|postgres|postgresql|supabase|mysql|sqlite|libsql|mongodb|mariadb|dynamodb|cockroach|database|db)\b/i;

export function attributeForValue(value: string): string {
  const v = value.toLowerCase();
  if (DATABASE_RE.test(v)) return "database";
  if (CACHE_RE.test(v)) return "cache";
  if (STORAGE_RE.test(v)) return "storage";
  if (EMBEDDING_RE.test(v)) return "semantic_retrieval";
  if (LLM_RE.test(v)) return "summarization";
  if (FRAMEWORK_RE.test(v)) return "framework";
  if (RUNTIME_RE.test(v)) return "runtime";
  return "technology";
}

export function attributeForPurpose(purpose: string): string | null {
  const p = purpose.toLowerCase();
  if (/\b(database|db|storage\b|data)\b/.test(p)) return "database";
  if (/\b(cache|redis|kv)\b/.test(p)) return "cache";
  if (/\b(object storage|storage|files)\b/.test(p)) return "storage";
  if (/\b(semantic|embedding|retrieval|vector)\b/.test(p)) return "semantic_retrieval";
  if (/\b(summariz|llm|model|ai|generation|completion)\b/.test(p)) return "summarization";
  if (/\b(framework|web framework)\b/.test(p)) return "framework";
  if (/\b(runtime|hosting|deploy|platform|server|edge)\b/.test(p)) return "runtime";
  if (/\b(api|interface|client|sdk)\b/.test(p)) return "technology";
  return null;
}

const USES_SUBJECT_RE =
  /^(?<subject>.*?)\s+(?:uses|is using|will use|relies on|is built on|runs on)\s+(?<rest>.+)$/i;

const PRONOUN_SUBJECTS: ReadonlySet<string> = new Set([
  "it", "this", "that", "the project", "the app", "the application", "the product",
  "the system", "the platform", "the service", "we", "our", "the gateway", "the tool",
]);

function splitClauses(rest: string): string[] {
  const parts = rest
    .split(/,|\band\b|\bwith\b/i)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts;
}

function inferAttributeFromClause(clause: string): { attr: string; value: string } {
  const lower = clause.toLowerCase();

  let m = clause.match(/^(.+?)\s+as\s+(?:the\s+|its\s+|our\s+)?([a-z0-9 _-]+?)\s*$/i);
  if (m && m[1] && m[2]) {
    return { attr: slugify(m[2].trim()), value: m[1].trim() };
  }

  m = clause.match(/^(.+?)\s+for\s+(.+)$/i);
  if (m && m[1] && m[2]) {
    const purpose = m[2].trim();
    const attr = attributeForPurpose(purpose) ?? slugify(purpose);
    let value = m[1].trim();
    if (attributeForPurpose(purpose)) {
      value = cleanVal(value);
    }
    return { attr, value };
  }

  return { attr: attributeForValue(clause), value: clause.trim() };
}

export function extractUsesList(text: string): StructuredFact[] {
  const cleaned = text.trim();
  const m = cleaned.match(USES_SUBJECT_RE);
  if (!m || !m.groups) return [];

  let subject = m.groups.subject.trim();
  if (PRONOUN_SUBJECTS.has(subject.toLowerCase())) {
    subject = "project";
  }
  if (!subject || INVALID_KEYS.has(subject.toLowerCase())) return [];

  const rest = m.groups.rest.trim();
  const clauses = splitClauses(rest);
  if (clauses.length < 2) return [];

  const scope = subject.toLowerCase() === "user" ? "user" : "project";
  const facts: StructuredFact[] = [];
  const seen = new Set<string>();

  for (const clause of clauses) {
    const { attr, value } = inferAttributeFromClause(clause);
    if (!value) continue;
    const fact: StructuredFact = {
      entity: subject,
      attribute: attr,
      value: cleanVal(value),
      memoryType: MemoryType.DECISION,
      rawText: text,
      key: `${scope}.${slugify(attr)}`,
      scope,
    };
    const factKey = fact.key!;
    if (seen.has(factKey)) continue;
    seen.add(factKey);
    facts.push(fact);
  }

  return facts;
}

export function splitSentences(text: string): string[] {
  if (!text) return [];
  return text
    .split(/(?<=[.;!?])\s+(?=[A-Z"'(])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ============================================================
// 3. PREPROCESSING UTILITIES
// ============================================================

const UNICODE_APOSTROPHES: ReadonlyMap<string, string> = new Map([
  ["\u2019", "'"], // ’ right single quotation mark
  ["\u2018", "'"], // ' left single quotation mark
  ["\u201b", "'"], // ‛ single high-reversed-9 quotation mark
  ["\u02BC", "'"], // ʼ modifier letter apostrophe
  ["\u02BB", "'"], // ʻ modifier letter turned comma
]);

const SMART_QUOTES: ReadonlyMap<string, string> = new Map([
  ['\u201c', '"'], // “
  ['\u201d', '"'], // ”
  ['\u201e', '"'], // ‟
  ['\u201f', '"'], // ❛
]);

const CONTRACTION_MAP: ReadonlyMap<string, string> = new Map([
  ["doesn't", "does not"],
  ["don't", "do not"],
  ["can't", "cannot"],
  ["won't", "will not"],
  ["isn't", "is not"],
  ["aren't", "are not"],
  ["wasn't", "was not"],
  ["weren't", "were not"],
  ["haven't", "have not"],
  ["hasn't", "has not"],
  ["hadn't", "had not"],
  ["didn't", "did not"],
  ["wouldn't", "would not"],
  ["couldn't", "could not"],
  ["shouldn't", "should not"],
  ["mustn't", "must not"],
  ["i'm", "i am"],
  ["i've", "i have"],
  ["i'll", "i will"],
  ["i'd", "i would"],
  ["you're", "you are"],
  ["you've", "you have"],
  ["you'll", "you will"],
  ["we're", "we are"],
  ["we've", "we have"],
  ["we'll", "we will"],
  ["that's", "that is"],
  ["it's", "it is"],
  ["there's", "there is"],
  ["here's", "here is"],
  ["what's", "what is"],
  ["let's", "let us"],
]);

const REPEATED_PUNCT_RE = /([.!?])\1+/g;
const MULTI_SPACE_RE = /\s+/g;
const LEADING_TRAIL_SPACE_RE = /^\s+|\s+$/g;

/**
 * Normalize text for pattern matching. Preserves original as rawText.
 * Handles unicode apostrophes, smart quotes, contractions, repeated punctuation.
 */
export function normalizeText(text: string): string {
  let s = text.normalize("NFKC");
  // Unicode apostrophes → straight apostrophe
  for (const [from, to] of UNICODE_APOSTROPHES) {
    s = s.replaceAll(from, to);
  }
  // Smart quotes → straight quotes
  for (const [from, to] of SMART_QUOTES) {
    s = s.replaceAll(from, to);
  }
  // Contractions → expanded form
  for (const [from, to] of CONTRACTION_MAP) {
    s = s.replaceAll(from, to);
    s = s.replaceAll(from.charAt(0).toUpperCase() + from.slice(1), to.charAt(0).toUpperCase() + to.slice(1));
  }
  // Repeated punctuation → single
  s = s.replace(REPEATED_PUNCT_RE, "$1");
  // Normalize whitespace
  s = s.replace(MULTI_SPACE_RE, " ");
  s = s.replace(LEADING_TRAIL_SPACE_RE, "");
  return s.trim().toLowerCase();
}

/** Normalize just contractions for matching purposes. */
export function normalizeContractions(text: string): string {
  let s = text;
  for (const [from, to] of CONTRACTION_MAP) {
    s = s.replaceAll(from, to);
    s = s.replaceAll(from.charAt(0).toUpperCase() + from.slice(1), to.charAt(0).toUpperCase() + to.slice(1));
  }
  return s;
}

/** Normalize unicode apostrophes and smart quotes. */
export function normalizeQuotes(text: string): string {
  let s = text.normalize("NFKC");
  for (const [from, to] of UNICODE_APOSTROPHES) {
    s = s.replaceAll(from, to);
  }
  for (const [from, to] of SMART_QUOTES) {
    s = s.replaceAll(from, to);
  }
  return s;
}

/**
 * Split on sentence boundaries (., !, ?) plus semicolons.
 * Also splits contrast clauses ("X but now Y") and comma-separated
 * first-person clauses ("X, I stopped using Y") so pattern matchers
 * capture values greedily only within their own clause.
 */
export function splitSentencesByBoundary(text: string): string[] {
  if (!text) return [];
  return text
    .split(
      /(?<=[.;!?])\s+(?=[A-Za-z"'(])|,\s*but\s+|\s+but\s+(?=(?:now|these\s+days|currently)\b)|,\s+(?=(?:and\s+)?(?:now|i|we)\b)|\s+and\s+(?=(?:i|we|my)\b)/i,
    )
    .map((s) => s.trim())
    .filter(Boolean);
}

// ============================================================
// 4. PATTERN TABLES
// ============================================================

/** Patterns for "my name is X", "call me X", etc. */
const IDENTITY_PATTERNS: ReadonlyArray<{
  re: RegExp;
  attribute: string;
  confidence: number;
}> = [
  { re: /^\s*(?:my\s+)?(?:full\s+)?name\s+is\s+(?<val>.+?)\s*[.!?]?$/i, attribute: "name", confidence: 1.0 },
  { re: /^\s*(?:i\s+am|i'm|we\s+are|we're)\s+(?<val>.+?)\s+years?\s+old\s*[.!?]?$/i, attribute: "age", confidence: 1.0 },
  { re: /^\s*(?:my\s+)?(?:full\s+)?age\s+is\s+(?<val>.+?)\s*[.!?]?$/i, attribute: "age", confidence: 1.0 },
  { re: /^\s*(?:call\s+me|you\s+can\s+call\s+me|people\s+call\s+me)\s+(?<val>.+?)\s*[.!?]?$/i, attribute: "name", confidence: 1.0 },
  { re: /^\s*(?:my\s+)?(?:username|nickname|full\s+name)\s+is\s+(?<val>.+?)\s*[.!?]?$/i, attribute: "name", confidence: 1.0 },
];

/** Patterns for age/location/occupation identity statements. */
const IDENTITY_FACTS: ReadonlyArray<{
  re: RegExp;
  attribute: string;
}> = [
  { re: /^\s*(?:i\s+am|i'm|i'm\s+from|i'm\s+based\s+in)\s+(?<val>.+?)\s*[.!?]?$/i, attribute: "location" },
  { re: /^\s*(?:i\s+live|i\s+stay|i'm\s+based)\s+in\s+(?<val>.+?)\s*[.!?]?$/i, attribute: "location" },
  { re: /^\s*(?:i\s+am\s+from|i'm\s+from)\s+(?<val>.+?)\s*[.!?]?$/i, attribute: "location" },
  { re: /^\s*(?:i\s+am|i'm)\s+(?<val>.+?)\s+(?:years?\s+old|years old)\s*[.!?]?$/i, attribute: "age" },
];

/** Patterns for identity role/occupation statements that ARE durable, NOT transient emotions. */
const IDENTITY_ROLE_PATTERNS: ReadonlyArray<{
  re: RegExp;
  attribute: string;
  confidence: number;
}> = [
  { re: /^\s*(?:i\s+(?:am|'m|am\s+also)|we\s+are)\s+(?<val>.+?(?:student|developer|founder|engineer|designer|architect|manager|leader|ceo|cto|pm|analyst|consultant|freelancer|teacher|professor|doctor|nurse|lawyer|writer|artist|musician|entrepreneur))(?:\s+and\s+.+)?\s*[.!?]?$/i, attribute: "occupation", confidence: 0.95 },
];

/** Durable identity words that when following "I am" indicate identity. */
const DURABLE_IDENTITY_WORDS: ReadonlySet<string> = new Set([
  "student", "developer", "founder", "engineer", "designer", "architect",
  "manager", "leader", "ceo", "cto", "pm", "analyst", "consultant",
  "freelancer", "teacher", "professor", "doctor", "nurse", "lawyer",
  "writer", "artist", "musician", "entrepreneur",
]);

const TRANSIENT_IDENTITY_WORDS: ReadonlySet<string> = new Set([
  "tired", "happy", "confused", "sad", "angry", "excited", "hungry",
  "thirsty", "busy", "tired", "bored", "curious", "nervous", "scared",
  "worried", "proud", "ashamed", "grateful", "hopeful", "motivated",
]);

/** Ownership patterns: "I own X", "my X is Y", "this is my X". */
const OWNERSHIP_PATTERNS: ReadonlyArray<{
  re: RegExp;
  attribute: string;
  confidence: number;
}> = [
  { re: /^\s*(?:i\s+(?:have|own|maintain|manage|run|operate)|we\s+(?:have|own|maintain|manage|run|operate))\s+(?:a\s+|an\s+)?(?<val>.+?)\s*[.!?]?$/i, attribute: "ownership", confidence: 0.95 },
  { re: /^\s*my\s+(?<attr>.+?)\s+is\s+(?<val>.+?)\s*[.!?]?$/i, attribute: "ownership", confidence: 0.95 },
  { re: /^\s*this\s+is\s+my\s+(?<val>.+?)\s*[.!?]?$/i, attribute: "ownership", confidence: 0.95 },
  { re: /^\s*(?<val>.+?)\s+belongs\s+to\s+me\s*[.!?]?$/i, attribute: "ownership", confidence: 0.95 },
];

/** Transient possession words to skip (not durable ownership). */
const TRANSIENT_POSSESSION: ReadonlySet<string> = new Set([
  "headache", "question", "idea", "minutes", "opinion", "thought",
  "concern", "suspicion", "hunch", "feeling", "impression",
]);

/** Current usage patterns: "I use X", "X uses Y". */
const USAGE_PATTERNS: ReadonlyArray<{
  re: RegExp;
  entity?: string;
  confidence: number;
}> = [
  { re: /^\s*(?:and\s+)?(?:now\s+|currently\s+|these\s+days\s+|at\s+the\s+moment\s+|right\s+now\s+|today\s+)?(?:i\s+(?:currently\s+)?use|i\s+am\s+using|i'm\s+using|we\s+(?:currently\s+)?use|we're\s+using)\s+(?<val>.+?)\s*[.!?]?$/i, confidence: 0.98 },
  { re: /^\s*(?:our\s+(?:system|team|project)\s+uses|my\s+(?:project|app|system)\s+uses)\s+(?<val>.+?)\s*[.!?]?$/i, confidence: 0.96 },
];

/** Past usage patterns: "I used X", "I used to use X". */
const PAST_USAGE_PATTERNS: ReadonlyArray<{
  re: RegExp;
  attribute: string;
  confidence: number;
}> = [
  { re: /^\s*(?:i\s+(?:used\s+to\s+use|used|previously\s+used|previously\s+relied\s+on|formerly\s+used|was\s+using|had\s+been\s+using))\s+(?<val>.+?)\s*[.!?]?$/i, attribute: "usage", confidence: 0.95 },
];

/** Stopped usage patterns: "I stopped using X", "I no longer use X". */
const STOPPED_USAGE_PATTERNS: ReadonlyArray<{
  re: RegExp;
  attribute: string;
  confidence: number;
}> = [
  { re: /^\s*(?:i\s+stopped\s+(?:using\s+)?|i\s+no\s+longer\s+use|i\s+don't\s+use\s+anymore|i\s+do\s+not\s+use\s+anymore|i\s+quit\s+(?:using\s+)?|i\s+abandoned|i\s+moved\s+away\s+from|i\s+switched\s+away\s+from|i\s+replaced\s+|i\s+removed\s+|i\s+discontinued)\s+(?<val>.+?)(?:\s+because\s+(?<reason>.+?))?\s*[.!?]?$/i, attribute: "usage", confidence: 0.95 },
];

/** Preference patterns: "I prefer X", "I like X", "I prefer X over Y". */
const PREFERENCE_PATTERNS: ReadonlyArray<{
  re: RegExp;
  attribute: string;
  confidence: number;
}> = [
  { re: /^\s*(?:i\s+)?prefer\s+(?<val>.+?)(?:\s+over\s+(?<over>.+?))?\s*[.!?]?$/i, attribute: "preference", confidence: 0.98 },
  { re: /^\s*(?:i\s+)?(?:really\s+)?like\s+(?<val>.+?)\s*[.!?]?$/i, attribute: "preference", confidence: 0.95 },
  { re: /^\s*(?:i\s+)?(?:really\s+)?love\s+(?<val>.+?)\s*[.!?]?$/i, attribute: "preference", confidence: 0.95 },
  { re: /^\s*(?:i\s+)?(?:would\s+rather\s+use|i'd\s+rather\s+use)\s+(?<val>.+?)(?:\s+over\s+(?<over>.+?))?\s*[.!?]?$/i, attribute: "preference", confidence: 0.96 },
  { re: /^\s*(?:i\s+)?choose\s+(?<val>.+?)(?:\s+over\s+(?<over>.+?))?\s*[.!?]?$/i, attribute: "preference", confidence: 0.95 },
  { re: /^\s*(?:i\s+)?usually\s+choose\s+(?<val>.+?)\s*[.!?]?$/i, attribute: "preference", confidence: 0.92 },
  { re: /^\s*(?:x|it)\s+is\s+my\s+preferred\s+(?<attr>.+?)\s+is\s+(?<val>.+?)\s*[.!?]?$/i, attribute: "preference", confidence: 0.95 },
];

/** Dislike patterns: "I don't like X", "I avoid X", "I never use X". */
const DISLIKE_PATTERNS: ReadonlyArray<{
  re: RegExp;
  attribute: string;
  confidence: number;
}> = [
  { re: /^\s*(?:i\s+don't\s+(?:really\s+)?like|i\s+do\s+not\s+(?:really\s+)?like|i\s+dislike|i\s+hate)\s+(?<val>.+?)(?:\s+anymore|\s+any\s+more)?\s*[.!?]?$/i, attribute: "dislike", confidence: 0.95 },
  { re: /^\s*(?:i\s+never\s+use|i\s+avoid|i\s+don't\s+want\s+to\s+use|i\s+refuse\s+to\s+use)\s+(?<val>.+?)\s*[.!?]?$/i, attribute: "dislike", confidence: 0.92 },
  { re: /^\s*(?:x|it)\s+is\s+not\s+for\s+me\s*[.!?]?$/i, attribute: "dislike", confidence: 0.85 },
  { re: /^\s*i\s+am\s+not\s+a\s+fan\s+of\s+(?<val>.+?)\s*[.!?]?$/i, attribute: "dislike", confidence: 0.85 },
];

/** Favorite patterns: "my favorite X is Y". */
const FAVORITE_PATTERNS: ReadonlyArray<{
  re: RegExp;
  domainRe: RegExp;
  confidence: number;
}> = [
  { re: /^\s*(?:my\s+)?(?:favorite|favourite)\s+(?<attr>.+?)\s+(?:is|are|=|:)\s+(?<val>.+?)\s*[.!?]?$/i, domainRe: /\b(color|colour|food|language|framework|database|editor|ide|os|operating\s+system|programming\s+language|ui\s+library|frontend\s+framework|backend\s+framework|cloud\s+provider|hosting\s+provider|browser|game|movie|book|music|artist|tool)\b/i, confidence: 0.98 },
  { re: /^\s*(?:my\s+)?(?:preferred|favourite)\s+(?<attr>.+?)\s+(?:is|are|=|:)\s+(?<val>.+?)\s*[.!?]?$/i, domainRe: /\b(color|colour|food|language|framework|database|editor|ide|os|operating\s+system|programming\s+language|ui\s+library|frontend\s+framework|backend\s+framework|cloud\s+provider|hosting\s+provider|browser|game|movie|book|music|artist|tool)\b/i, confidence: 0.95 },
];

/** Favorite domain keywords for normalization. */
const FAVORITE_DOMAIN_MAP: ReadonlyMap<string, string> = new Map([
  ["color", "color"], ["colour", "color"], ["food", "food"],
  ["language", "language"], ["framework", "framework"],
  ["database", "database"], ["editor", "editor"], ["ide", "ide"],
  ["os", "os"], ["operating system", "os"],
  ["programming language", "language"],
  ["ui library", "ui_library"], ["frontend framework", "frontend_framework"],
  ["backend framework", "backend_framework"],
  ["cloud provider", "cloud_provider"],
  ["hosting provider", "hosting_provider"],
  ["browser", "browser"], ["game", "game"], ["movie", "movie"],
  ["book", "book"], ["music", "music"], ["artist", "artist"],
  ["tool", "tool"],
]);

/** Goal patterns: "I want to X", "I intend to X", "my goal is to X". */
const GOAL_PATTERNS: ReadonlyArray<{
  re: RegExp;
  attribute: string;
  confidence: number;
}> = [
  { re: /^\s*(?:i\s+want\s+to|i\s+would\s+like\s+to|i'd\s+like\s+to|i\s+hope\s+to|i\s+intend\s+to|my\s+goal\s+is\s+to|i\s+aim\s+to|i\s+need\s+to|i\s+wish\s+to)\s+(?<val>.+?)\s*[.!?]?$/i, attribute: "goal", confidence: 0.95 },
];

/** Plan patterns: "I plan to X", "I'm planning to X". */
const PLAN_PATTERNS: ReadonlyArray<{
  re: RegExp;
  attribute: string;
  confidence: number;
}> = [
  { re: /^\s*(?:i\s+plan\s+to|i'm\s+planning\s+to|i\s+am\s+planning\s+to|i\s+will\s+probably|i'm\s+going\s+to|i\s+intend\s+to|i\s+expect\s+to|i\s+am\s+preparing\s+to)\s+(?<val>.+?)\s*[.!?]?$/i, attribute: "plan", confidence: 0.95 },
];

/** Possible/uncertain plan patterns: "I might X", "maybe I'll X". */
const POSSIBLE_PLAN_PATTERNS: ReadonlyArray<{
  re: RegExp;
  attribute: string;
  confidence: number;
}> = [
  { re: /^\s*(?:i\s+might|i\s+may|i\s+could|maybe\s+i'll|perhaps\s+i'll|i'm\s+considering|i'm\s+thinking\s+about|i\s+am\s+thinking\s+about|i\s+may\s+decide\s+to|i'm\s+not\s+sure\s+but|possibly|there's\s+a\s+chance\s+i'll)\s+(?<val>.+?)\s*[.!?]?$/i, attribute: "plan", confidence: 0.7 },
];

/** Decision patterns: "I decided to X", "I chose X". */
const DECISION_PATTERNS: ReadonlyArray<{
  re: RegExp;
  attribute: string;
  confidence: number;
}> = [
  { re: /^\s*(?:i\s+decided\s+to|i've\s+decided\s+to|i\s+have\s+decided\s+to|i\s+chose\s+|i\s+selected\s+|i've\s+chosen\s+|i\s+settled\s+on|we\s+decided\s+to|we\s+chose)\s+(?<val>.+?)\s*[.!?]?$/i, attribute: "decision", confidence: 0.95 },
];

/** Conditional language patterns. */
const CONDITIONAL_PATTERNS: ReadonlyArray<{
  re: RegExp;
  confidence: number;
}> = [
  { re: /^\s*(?:if\s+.+\s+then\s+i\s+will|if\s+.+\s+works\s+i'll\s+use|i\s+will\s+use\s+if|i\s+might\s+use\s+if|depending\s+on|unless\s+|provided\s+that|only\s+if)\s+/i, confidence: 0.6 },
];

/** Temporary state patterns: "I'm testing X", "I'm debugging X". */
const TEMPORARY_PATTERNS: ReadonlyArray<{
  re: RegExp;
  confidence: number;
}> = [
  { re: /^\s*(?:i'm\s+testing|i'm\s+trying|i'm\s+debugging|i'm\s+currently\s+debugging|i'm\s+experimenting\s+with|i'm\s+checking\s+|i'm\s+looking\s+at|i'm\s+reading\s+about|i'm\s+learning\s+about)\s+(?<val>.+?)\s*[.!?]?$/i, confidence: 0.4 },
];

/** Obvious non-memory conversational content. */
const NON_MEMORY_PATTERNS: ReadonlyArray<{
  re: RegExp;
  reason: string;
}> = [
  { re: /^\s*(?:hello|hi|hey|yo|sup|greetings|good\s+morning|good\s+afternoon|good\s+evening|good\s+night)(?:\s+(?:there|folks|everyone|all|team|guys|bro|dude|man|friend))?\s*[!.?]*$/i, reason: "greeting_or_acknowledgement" },
  { re: /^\s*(?:what\s+is\s+|what's\s+what\s+is\s+|how\s+does\s+.+?\s+work|explain\s+|summarize\s+|translate\s+|rewrite\s+|make\s+a\s+prompt|create\s+a\s+function|give\s+me\s+an\s+example|search\s+for|find\s+|calculate\s+|convert\s+)\s+/i, reason: "general_knowledge_or_coding_request" },
];

/** Question words that indicate interrogative content. */
const INTERROGATIVE_STARTS: ReadonlySet<string> = new Set([
  "what", "why", "how", "when", "where", "who", "which", "should",
  "can", "could", "would", "is", "are", "do", "does", "did", "will",
]);

/** Temporal markers for state detection. */
const TEMPORAL_MARKERS: ReadonlyMap<string, FactState> = new Map([
  ["currently", "current"], ["now", "current"], ["today", "current"],
  ["at the moment", "current"], ["right now", "current"],
  ["these days", "current"], ["for now", "current"],
  ["already", "current"], ["still", "current"], ["yet", "current"],
  ["before", "past"], ["previously", "past"], ["formerly", "past"],
  ["used to", "past"], ["in the past", "past"], ["earlier", "past"],
  ["last year", "past"], ["last month", "past"], ["yesterday", "past"],
  ["recently", "past"], ["soon", "planned"], ["later", "planned"],
  ["eventually", "planned"], ["next week", "planned"],
  ["next month", "planned"], ["next year", "planned"],
  ["in the future", "planned"], ["someday", "planned"],
]);

/** Technology keyword database for classification. */
const TECH_KEYWORDS: ReadonlySet<string> = new Set([
  // Databases
  "postgres", "postgresql", "mysql", "mariadb", "sqlite", "mongodb", "mongo",
  "redis", "valkey", "dynamodb", "d1", "turso", "libsql", "neon", "supabase",
  "planetscale", "cockroachdb", "cockroach", "pglite", "pinecone", "weaviate",
  "qdrant", "milvus", "faiss", "elasticsearch", "opensearch", "clickhouse",
  "upstash",
  // Cloud
  "aws", "amazon web services", "ec2", "lambda", "s3", "cloudfront",
  "dynamodb", "api gateway", "gcp", "google cloud", "cloud run", "cloud build",
  "firebase", "azure", "oracle cloud", "oci", "cloudflare", "workers", "pages",
  "r2", "kv", "queues", "durable objects", "vercel", "netlify", "fly.io",
  "render", "railway",
  // Hosting/CDN
  "cdn", "bunny", "bunnycdn", "fastly", "akamai", "tenbyte", "minio",
  "caddy", "nginx", "traefik", "haproxy",
  // Languages
  "typescript", "javascript", "python", "go", "golang", "rust", "java",
  "kotlin", "swift", "c", "c++", "csharp", "php", "ruby", "dart", "lua",
  // Frontend
  "react", "next", "next.js", "vue", "nuxt", "svelte", "sveltekit", "astro",
  "solid", "angular", "remix", "tanstack", "mui", "material ui", "shadcn",
  "tailwind", "bootstrap", "chakra",
  // Backend
  "express", "fastify", "hono", "nestjs", "django", "flask", "fastapi",
  "spring", "laravel", "elysia", "bun", "node", "node.js", "deno",
  // Infrastructure
  "docker", "docker compose", "kubernetes", "k8s", "helm", "terraform",
  "pulumi", "ansible", "bullmq", "rabbitmq", "kafka", "nats",
  // AI
  "openai", "anthropic", "claude", "gemini", "groq", "deepseek", "qwen",
  "llama", "mistral", "openrouter", "hugging face", "huggingface", "ollama",
  "vllm", "llm", "embedding", "embeddings", "vector", "reranker", "agent", "agents",
]);

/** Domains for generic entity classification. */
const GENERIC_DOMAINS: ReadonlySet<string> = new Set([
  "name", "age", "location", "country", "city", "occupation", "job",
  "role", "education", "school", "university", "project", "business",
  "company", "domain", "website", "email", "language", "framework",
  "database", "hosting", "cloud", "editor", "ide", "os", "device",
  "hardware", "preference", "goal", "plan", "decision", "habit",
  "workflow", "budget", "subscription", "account", "ownership",
  "relationship",
]);

// ============================================================
// 5. MEMORY GATE
// ============================================================

export type MemoryGateResult = {
  shouldCallGroq: boolean;
  confidence: number;
  reasons: string[];
  candidateKinds: string[];
};

/**
 * Determine whether a message should be skipped, handled locally,
 * or escalated to Groq for semantic extraction.
 */
export function shouldConsiderMemory(text: string): MemoryGateResult {
  const cleaned = text.trim();
  if (!cleaned) {
    return { shouldCallGroq: false, confidence: 0.99, reasons: ["empty"], candidateKinds: [] };
  }

  const normalized = normalizeText(cleaned);
  const reasons: string[] = [];

  // 1. Check obvious non-memory patterns first
  for (const pattern of NON_MEMORY_PATTERNS) {
    const m = pattern.re.exec(normalized);
    if (m) {
      return { shouldCallGroq: false, confidence: 0.99, reasons: [pattern.reason], candidateKinds: [] };
    }
  }

  // 2. Check if it's a pure question (no declarative memory content)
  if (isInterrogative(cleaned)) {
    // Allow declarative statements that contain questions (e.g. "I use Neon. What do you think?")
    // Only skip if the whole message is a question.
    const sentences = splitSentencesByBoundary(cleaned);
    if (sentences.length === 1) {
      // Single question without declarative content → skip
      const stripped = cleaned.replace(/[.!?]\s*$/, "").trim();
      if (INTERROGATIVE_STARTS.has(stripped.split(/\s+/)[0]?.toLowerCase() || "")) {
        return { shouldCallGroq: false, confidence: 0.99, reasons: ["pure_question"], candidateKinds: [] };
      }
    }
  }

  // 3. Check low-info phrases (whole-message match only, never substring)
  const lowInfoPhrases = [
    "ok", "okay", "k", "kk", "yes", "yep", "yeah", "yup", "no", "nope",
    "nah", "thanks", "thank you", "thx", "ty", "cool", "great", "nice",
    "good", "fine", "sure", "got it", "sounds good", "works for me",
    "makes sense", "understood", "perfect", "awesome",
  ];
  const strippedNormalized = normalized.replace(/[.!?]+$/g, "").trim();
  const tokens = strippedNormalized.split(/\s+/);
  if (
    lowInfoPhrases.includes(strippedNormalized) ||
    (tokens.length > 0 && tokens.every((t) => lowInfoPhrases.includes(t)))
  ) {
    return { shouldCallGroq: false, confidence: 0.99, reasons: ["low_info"], candidateKinds: [] };
  }

  // 4. Per-clause local pattern scan
  const clauses = splitSentencesByBoundary(cleaned);
  const candidateKinds: string[] = [];
  const unmatchedClauses: string[] = [];

  const localPatternSets = [
    { set: IDENTITY_PATTERNS, kind: "identity" },
    { set: USAGE_PATTERNS, kind: "usage" },
    { set: PREFERENCE_PATTERNS, kind: "preference" },
    { set: DISLIKE_PATTERNS, kind: "dislike" },
    { set: FAVORITE_PATTERNS, kind: "favorite" },
    { set: GOAL_PATTERNS, kind: "goal" },
    { set: PLAN_PATTERNS, kind: "plan" },
    { set: POSSIBLE_PLAN_PATTERNS, kind: "possible_plan" },
    { set: DECISION_PATTERNS, kind: "decision" },
    { set: OWNERSHIP_PATTERNS, kind: "ownership" },
    { set: PAST_USAGE_PATTERNS, kind: "past_usage" },
    { set: STOPPED_USAGE_PATTERNS, kind: "stopped_usage" },
    { set: TEMPORARY_PATTERNS, kind: "temporary" },
  ];

  for (const clause of clauses) {
    let matchedKind: string | null = null;
    let matchedConfidence = 0;

    for (const { set, kind } of localPatternSets) {
      for (const pattern of set) {
        if (pattern.re.exec(clause)) {
          matchedKind = kind;
          matchedConfidence = Math.max(matchedConfidence, pattern.confidence);
          break;
        }
      }
      if (matchedKind) break;
    }

    if (matchedKind) {
      if (!candidateKinds.includes(matchedKind)) candidateKinds.push(matchedKind);
    } else {
      unmatchedClauses.push(clause);
    }
  }

  // 5. Any clause without local coverage is ambiguous → Groq (if memory-like)
  if (unmatchedClauses.length > 0) {
    const hasMemoryKeywords = [
      "use", "used", "using", "prefer", "like", "love", "hate", "dislike", "avoid", "want",
      "plan", "goal", "decided", "chose", "stopped", "no", "longer",
      "building", "creating", "developing", "working", "maintain", "learning",
      "own", "have", "has", "favorite", "preferred", "intend",
      "am", "name", "call", "testing", "trying", "switching", "migrating",
      "live", "living", "reside", "residing", "based", "stay", "staying", "hail", "from",
    ].some((kw) => new RegExp(`\\b${kw}\\b`).test(normalized));

    if (!hasMemoryKeywords && candidateKinds.length === 0) {
      return { shouldCallGroq: false, confidence: 0.85, reasons: ["no_memory_keywords"], candidateKinds: [] };
    }
    return {
      shouldCallGroq: true,
      confidence: 0.5,
      reasons: ["ambiguous_semantic"],
      candidateKinds: candidateKinds.includes("ambiguous") ? candidateKinds : [...candidateKinds, "ambiguous"],
    };
  }

  // 6. All clauses matched local patterns → handle locally
  if (candidateKinds.length > 0) {
    return { shouldCallGroq: false, confidence: 0.95, reasons: ["local_patterns"], candidateKinds };
  }

  // 7. Fallback: skip (no coverage, no keywords)
  return { shouldCallGroq: false, confidence: 0.85, reasons: ["no_memory_keywords"], candidateKinds: [] };
}

// ============================================================
// 6. LOCAL CONFIDENCE SCORING
// ============================================================

export type ConfidenceLevel =
  | "explicit_identity"
  | "explicit_preference"
  | "explicit_usage"
  | "explicit_stopped"
  | "explicit_plan"
  | "clear_goal"
  | "clear_decision"
  | "ambiguous"
  | "weak_contextual";

export function scoreConfidence(kind: string, explicit: boolean): number {
  const map: Record<string, Record<string, number>> = {
    identity: { explicit: 1.00, implicit: 0.85 },
    preference: { explicit: 0.98, implicit: 0.75 },
    usage: { explicit: 0.98, implicit: 0.70 },
    stopped_usage: { explicit: 0.98, implicit: 0.70 },
    past_usage: { explicit: 0.95, implicit: 0.70 },
    plan: { explicit: 0.95, implicit: 0.60 },
    possible_plan: { explicit: 0.70, implicit: 0.40 },
    goal: { explicit: 0.95, implicit: 0.70 },
    decision: { explicit: 0.95, implicit: 0.70 },
    ownership: { explicit: 0.95, implicit: 0.75 },
    temporary: { explicit: 0.40, implicit: 0.25 },
    ambiguous: { explicit: 0.70, implicit: 0.50 },
  };
  const entry = map[kind] || map.ambiguous;
  return explicit ? entry.explicit : entry.implicit;
}

// ============================================================
// 7. NEW LOCAL EXTRACTORS
// ============================================================

export interface LocalExtractionResult {
  fact: StructuredFact | null;
  confidence: number;
  route: "local";
  reason: string;
}

/** Extract identity facts: "My name is X", "I'm a student", "I'm 19". */
export function extractIdentity(text: string): LocalExtractionResult | null {
  const cleaned = text.trim();

  // Check identity patterns
  for (const pattern of IDENTITY_PATTERNS) {
    const m = pattern.re.exec(cleaned);
    if (m && m.groups?.val) {
      let val = cleanVal(m.groups.val);
      if (!val || INVALID_KEYS.has(val.toLowerCase())) continue;
      return {
        fact: {
          entity: "user",
          attribute: pattern.attribute,
          value: val,
          memoryType: MemoryType.FACT,
          rawText: text,
          key: `user.${pattern.attribute}`,
          scope: "user",
          state: "current",
          confidence: pattern.confidence,
        },
        confidence: pattern.confidence,
        route: "local",
        reason: "identity_pattern",
      };
    }
  }

  // Check "I am a [durable role]" — but NOT transient emotions
  for (const pattern of IDENTITY_ROLE_PATTERNS) {
    const m = pattern.re.exec(cleaned);
    if (m && m.groups?.val) {
      let val = cleanVal(m.groups.val);
      if (!val || INVALID_KEYS.has(val.toLowerCase())) continue;
      // Make sure it's not a transient emotion
      const valLower = val.toLowerCase();
      if (TRANSIENT_IDENTITY_WORDS.has(valLower)) continue;
      return {
        fact: {
          entity: "user",
          attribute: pattern.attribute,
          value: val,
          memoryType: MemoryType.FACT,
          rawText: text,
          key: `user.${pattern.attribute}`,
          scope: "user",
          state: "current",
          confidence: pattern.confidence,
        },
        confidence: pattern.confidence,
        route: "local",
        reason: "identity_role",
      };
    }
  }

  // "I live in X" / "I'm from X" location identity facts
  for (const pattern of IDENTITY_FACTS) {
    const m = pattern.re.exec(cleaned);
    if (m && m.groups?.val) {
      let val = cleanVal(m.groups.val);
      if (!val || INVALID_KEYS.has(val.toLowerCase())) continue;
      const isAge = pattern.attribute === "age";
      if (isAge) {
        const ageMatch = m.groups.val.match(/\d+/);
        val = ageMatch ? ageMatch[0] : val;
      }
      return {
        fact: {
          entity: "user",
          attribute: pattern.attribute,
          value: val,
          memoryType: MemoryType.FACT,
          rawText: text,
          key: `user.${pattern.attribute}`,
          scope: "user",
          state: "current",
          confidence: 1.0,
        },
        confidence: 1.0,
        route: "local",
        reason: isAge ? "identity_age" : "identity_location",
      };
    }
  }

  return null;
}

/** Extract ownership facts: "I own X", "my X is Y". */
export function extractOwnership(text: string): LocalExtractionResult | null {
  const cleaned = text.trim();

  for (const pattern of OWNERSHIP_PATTERNS) {
    const m = pattern.re.exec(cleaned);
    if (!m) continue;

    if (!m || !m.groups) continue;
    const val = cleanVal(m.groups.val || "");
    const attr = m.groups.attr ? cleanVal(m.groups.attr) : "ownership";
    if (!val || INVALID_KEYS.has(val.toLowerCase())) continue;

    // Skip transient possession
    const valLower = val.toLowerCase();
    if (TRANSIENT_POSSESSION.has(valLower)) continue;

    // Handle "my X is Y" → entity = X, value = Y
    let entity = "user";
    let value = val;
    if (m.groups.attr && m.groups.val) {
      entity = cleanVal(m.groups.attr);
      value = cleanVal(m.groups.val);
    }

    return {
      fact: {
        entity,
        attribute: attr === "ownership" ? attr : attr,
        value,
        memoryType: MemoryType.FACT,
        rawText: text,
        key: `user.${slugify(attr === "ownership" ? "ownership" : attr)}`,
        scope: "user",
        state: "current",
        confidence: pattern.confidence,
      },
      confidence: pattern.confidence,
      route: "local",
      reason: "ownership_pattern",
    };
  }

  // Handle "I have X" for durable ownership (not transient)
  const haveRe = /^\s*(?:i\s+(?:have|own|maintain|manage|run|operate))\s+(?:a\s+|an\s+)?(?<val>.+?)\s*[.!?]?$/i;
  const haveM = haveRe.exec(cleaned);
  if (haveM && haveM.groups?.val) {
    const val = cleanVal(haveM.groups.val);
    if (!val || INVALID_KEYS.has(val.toLowerCase())) return null;
    const valLower = val.toLowerCase();
    if (TRANSIENT_POSSESSION.has(valLower)) return null;
    return {
      fact: {
        entity: "user",
        attribute: "ownership",
        value: val,
        memoryType: MemoryType.FACT,
        rawText: text,
        key: "user.ownership",
        scope: "user",
        state: "current",
        confidence: 0.92,
      },
      confidence: 0.92,
      route: "local",
      reason: "have_pattern",
    };
  }

  return null;
}

/** Extract current usage: "I use X". */
export function extractCurrentUsage(text: string): LocalExtractionResult | null {
  const cleaned = text.trim();

  for (const pattern of USAGE_PATTERNS) {
    const m = pattern.re.exec(cleaned);
    if (!m || !m.groups?.val) continue;
    const val = cleanVal(m.groups.val);
    if (!val || INVALID_KEYS.has(val.toLowerCase())) continue;

    // Check negation in the original text
    if (/\b(not|don't|do not|doesn't|did not|never|no longer|without)\b/i.test(cleaned)) {
      return {
        fact: {
          entity: "user",
          attribute: "technology",
          value: val,
          memoryType: MemoryType.FACT,
          rawText: text,
          key: "user.technology",
          scope: "user",
          state: "stopped",
          confidence: 0.95,
        },
        confidence: 0.95,
        route: "local",
        reason: "negated_usage",
      };
    }

    return {
      fact: {
        entity: "user",
        attribute: "technology",
        value: val,
        memoryType: MemoryType.FACT,
        rawText: text,
        key: "user.technology",
        scope: "user",
        state: "current",
        confidence: pattern.confidence,
      },
      confidence: pattern.confidence,
      route: "local",
      reason: "current_usage",
    };
  }

  return null;
}

/** Extract past usage: "I used X". */
export function extractPastUsage(text: string): LocalExtractionResult | null {
  const cleaned = text.trim();

  for (const pattern of PAST_USAGE_PATTERNS) {
    const m = pattern.re.exec(cleaned);
    if (!m || !m.groups?.val) continue;
    const val = cleanVal(m.groups.val);
    if (!val || INVALID_KEYS.has(val.toLowerCase())) continue;

    return {
      fact: {
        entity: "user",
        attribute: "technology",
        value: val,
        memoryType: MemoryType.FACT,
        rawText: text,
        key: "user.technology",
        scope: "user",
        state: "past",
        confidence: pattern.confidence,
      },
      confidence: pattern.confidence,
      route: "local",
      reason: "past_usage",
    };
  }

  return null;
}

/** Extract stopped usage: "I stopped using X". */
export function extractStoppedUsage(text: string): LocalExtractionResult | null {
  const cleaned = text.trim();

  for (const pattern of STOPPED_USAGE_PATTERNS) {
    const m = pattern.re.exec(cleaned);
    if (!m || !m.groups?.val) continue;
    const val = cleanVal(m.groups.val);
    if (!val || INVALID_KEYS.has(val.toLowerCase())) continue;
    const reason = m.groups.reason ? cleanVal(m.groups.reason) : undefined;

    const fact: StructuredFact = {
      entity: "user",
      attribute: "technology",
      value: val,
      memoryType: MemoryType.FACT,
      rawText: text,
      key: "user.technology",
      scope: "user",
      state: "stopped",
      confidence: pattern.confidence,
      metadata: reason ? { reason } : undefined,
    };

    return {
      fact,
      confidence: pattern.confidence,
      route: "local",
      reason: "stopped_usage",
    };
  }

  return null;
}

/** Extract preference: "I prefer X over Y", "I like X". */
export function extractLocalPreference(text: string): LocalExtractionResult | null {
  const cleaned = text.trim();

  for (const pattern of PREFERENCE_PATTERNS) {
    const m = pattern.re.exec(cleaned);
    if (!m || !m.groups?.val) continue;
    let val = cleanVal(m.groups.val);
    if (!val || INVALID_KEYS.has(val.toLowerCase())) continue;

    const over = m.groups.over ? cleanVal(m.groups.over) : undefined;

    const [domain] = detectPreferenceDomain(val, over || "");
    const attribute = domain === "preference" ? "preference" : domain;
    const fact: StructuredFact = {
      entity: "user",
      attribute,
      value: val,
      memoryType: MemoryType.PREFERENCE,
      rawText: text,
      key: `user.preference.${slugify(attribute)}`,
      scope: "user",
      state: "current",
      confidence: pattern.confidence,
      metadata: over ? { preferred_over: over } : undefined,
    };

    return {
      fact,
      confidence: pattern.confidence,
      route: "local",
      reason: "local_preference",
    };
  }

  return null;
}

/** Extract dislike: "I don't like X", "I avoid X". */
export function extractLocalDislike(text: string): LocalExtractionResult | null {
  const cleaned = text.trim();

  for (const pattern of DISLIKE_PATTERNS) {
    const m = pattern.re.exec(cleaned);
    if (!m || !m.groups?.val) continue;
    const val = cleanVal(m.groups.val);
    if (!val || INVALID_KEYS.has(val.toLowerCase())) continue;

    // Don't confuse "I don't know X" with dislike
    if (/\bdon't know\b|\bdon't understand\b/i.test(cleaned)) return null;

    return {
      fact: {
        entity: "user",
        attribute: "dislike",
        value: val,
        memoryType: MemoryType.PREFERENCE,
        rawText: text,
        key: `user.dislike.${slugify(val)}`,
        scope: "user",
        state: "current",
        confidence: pattern.confidence,
      },
      confidence: pattern.confidence,
      route: "local",
      reason: "local_dislike",
    };
  }

  return null;
}

/** Extract favorite: "my favorite X is Y". */
export function extractFavorite(text: string): LocalExtractionResult | null {
  const cleaned = text.trim();

  for (const pattern of FAVORITE_PATTERNS) {
    const m = pattern.re.exec(cleaned);
    if (!m || !m.groups?.attr || !m.groups?.val) continue;

    const attrRaw = normalizePreferenceSpelling(m.groups.attr.trim());
    const val = cleanVal(m.groups.val);
    if (!val || isPreferenceNoiseValue(val)) continue;

    // Determine domain
    const attrLower = attrRaw.toLowerCase();
    let domain: string | null = null;
    if (pattern.domainRe.test(attrLower)) {
      domain = attrLower;
    }

    let attribute = attrRaw;
    if (domain) {
      const mapped = FAVORITE_DOMAIN_MAP.get(domain);
      if (mapped) attribute = mapped;
      else attribute = domain;
    } else {
      attribute = slugify(attrRaw);
    }

    const predicate = `favorite_${attribute}`;
    return {
      fact: {
        entity: "user",
        attribute: predicate,
        value: val,
        memoryType: MemoryType.PREFERENCE,
        rawText: text,
        key: `user.${predicate}`,
        scope: "user",
        state: "current",
        confidence: pattern.confidence,
      },
      confidence: pattern.confidence,
      route: "local",
      reason: "favorite_pattern",
    };
  }

  return null;
}

/** Extract goal: "I want to use X", "my goal is to X". */
export function extractGoal(text: string): LocalExtractionResult | null {
  const cleaned = text.trim();

  for (const pattern of GOAL_PATTERNS) {
    const m = pattern.re.exec(cleaned);
    if (!m || !m.groups?.val) continue;
    const val = cleanVal(m.groups.val);
    if (!val || INVALID_KEYS.has(val.toLowerCase())) continue;

    return {
      fact: {
        entity: "user",
        attribute: "goal",
        value: val,
        memoryType: MemoryType.GOAL,
        rawText: text,
        key: "user.goal",
        scope: "user",
        state: "planned",
        confidence: pattern.confidence,
      },
      confidence: pattern.confidence,
      route: "local",
      reason: "goal_pattern",
    };
  }

  return null;
}

/** Extract plan: "I plan to X", "I'm going to X". */
export function extractPlan(text: string): LocalExtractionResult | null {
  const cleaned = text.trim();

  for (const pattern of PLAN_PATTERNS) {
    const m = pattern.re.exec(cleaned);
    if (!m || !m.groups?.val) continue;
    const val = cleanVal(m.groups.val);
    if (!val || INVALID_KEYS.has(val.toLowerCase())) continue;

    return {
      fact: {
        entity: "user",
        attribute: "plan",
        value: val,
        memoryType: MemoryType.GOAL,
        rawText: text,
        key: "user.plan",
        scope: "user",
        state: "planned",
        confidence: pattern.confidence,
      },
      confidence: pattern.confidence,
      route: "local",
      reason: "plan_pattern",
    };
  }

  return null;
}

/** Extract possible/uncertain plan: "I might X", "maybe I'll X". */
export function extractPossiblePlan(text: string): LocalExtractionResult | null {
  const cleaned = text.trim();

  for (const pattern of POSSIBLE_PLAN_PATTERNS) {
    const m = pattern.re.exec(cleaned);
    if (!m || !m.groups?.val) continue;
    const val = cleanVal(m.groups.val);
    if (!val || INVALID_KEYS.has(val.toLowerCase())) continue;

    return {
      fact: {
        entity: "user",
        attribute: "plan",
        value: val,
        memoryType: MemoryType.GOAL,
        rawText: text,
        key: "user.plan",
        scope: "user",
        state: "possible",
        confidence: pattern.confidence,
      },
      confidence: pattern.confidence,
      route: "local",
      reason: "possible_plan_pattern",
    };
  }

  return null;
}

/** Extract decision: "I decided to X", "I chose X". */
export function extractDecision(text: string): LocalExtractionResult | null {
  const cleaned = text.trim();

  for (const pattern of DECISION_PATTERNS) {
    const m = pattern.re.exec(cleaned);
    if (!m || !m.groups?.val) continue;
    const val = cleanVal(m.groups.val);
    if (!val || INVALID_KEYS.has(val.toLowerCase())) continue;

    return {
      fact: {
        entity: "user",
        attribute: "decision",
        value: val,
        memoryType: MemoryType.DECISION,
        rawText: text,
        key: "user.decision",
        scope: "user",
        state: "current",
        confidence: pattern.confidence,
      },
      confidence: pattern.confidence,
      route: "local",
      reason: "decision_pattern",
    };
  }

  return null;
}

/** Detect conditional language: "if X then I will Y". */
export function extractConditional(text: string): LocalExtractionResult | null {
  const cleaned = text.trim();
  for (const pattern of CONDITIONAL_PATTERNS) {
    if (pattern.re.test(cleaned)) {
      // Try to extract the action from the conditional
      const actionMatch = cleaned.match(/\b(?:will\s+use|will\s+switch|will\s+adopt|will\s+choose)\s+(?<val>.+?)\s*[.!?]?$/i);
      if (actionMatch && actionMatch.groups?.val) {
        const val = cleanVal(actionMatch.groups.val);
        return {
          fact: {
            entity: "user",
            attribute: "plan",
            value: val,
            memoryType: MemoryType.GOAL,
          rawText: text,
            key: "user.plan",
            scope: "user",
            state: "conditional",
            confidence: pattern.confidence,
          },
          confidence: pattern.confidence,
          route: "local",
          reason: "conditional_language",
        };
      }
      return null; // Conditional but no clear action extracted
    }
  }
  return null;
}

/** Detect temporary state: "I'm testing X", "I'm debugging X". */
export function extractTemporaryState(text: string): LocalExtractionResult | null {
  const cleaned = text.trim();

  for (const pattern of TEMPORARY_PATTERNS) {
    const m = pattern.re.exec(cleaned);
    if (!m || !m.groups?.val) continue;
    const val = cleanVal(m.groups.val);
    if (!val || INVALID_KEYS.has(val.toLowerCase())) continue;

    return {
      fact: {
        entity: "user",
        attribute: "temporary_state",
        value: val,
        memoryType: MemoryType.TEMPORARY_STATE,
        rawText: text,
        key: "user.temporary_state",
        scope: "session",
        state: "current",
        confidence: pattern.confidence,
      },
      confidence: pattern.confidence,
      route: "local",
      reason: "temporary_state",
    };
  }

  return null;
}

/** Detect negation and mark accordingly. */
export function extractNegation(text: string): boolean {
  return /\b(not|don't|do not|doesn't|did not|never|no longer|without|cannot|can't|won't|wouldn't|isn't|is not|aren't|are not|wasn't|was not)\b/i.test(text);
}

// ============================================================
// 8. LOCAL EXTRACTION PIPELINE
// ============================================================

/** Run all local extractors and return candidate facts with confidence. */
export function extractLocalFacts(text: string): LocalExtractionResult[] {
  // Extract per clause so greedy values stay within their own clause
  const clauses = splitSentencesByBoundary(text);
  const list = clauses.length > 0 ? clauses : [text];

  const results: LocalExtractionResult[] = [];
  const seen = new Set<string>();

  for (const clause of list) {
    for (const r of extractLocalFactsFromClause(clause)) {
      const k = r.fact ? `${r.fact.key}|${r.fact.value}` : `${r.route}|${r.reason || ""}`;
      if (seen.has(k)) continue;
      seen.add(k);
      results.push(r);
    }
  }

  return results;
}

function extractLocalFactsFromClause(text: string): LocalExtractionResult[] {
  const results: LocalExtractionResult[] = [];

  // Identity
  const identity = extractIdentity(text);
  if (identity) results.push(identity);

  // Ownership
  const ownership = extractOwnership(text);
  if (ownership) results.push(ownership);

  // Current usage
  const usage = extractCurrentUsage(text);
  if (usage) results.push(usage);

  // Past usage
  const past = extractPastUsage(text);
  if (past) results.push(past);

  // Stopped usage
  const stopped = extractStoppedUsage(text);
  if (stopped) results.push(stopped);

  // Preference
  const pref = extractLocalPreference(text);
  if (pref) results.push(pref);

  // Dislike
  const dislike = extractLocalDislike(text);
  if (dislike) results.push(dislike);

  // Favorite
  const fav = extractFavorite(text);
  if (fav) results.push(fav);

  // Goal
  const goal = extractGoal(text);
  if (goal) results.push(goal);

  // Plan
  const plan = extractPlan(text);
  if (plan) results.push(plan);

  // Possible plan
  const possiblePlan = extractPossiblePlan(text);
  if (possiblePlan) results.push(possiblePlan);

  // Decision
  const decision = extractDecision(text);
  if (decision) results.push(decision);

  // Temporary state
  const temp = extractTemporaryState(text);
  if (temp) results.push(temp);

  // Conditional
  const conditional = extractConditional(text);
  if (conditional) results.push(conditional);

  return results;
}

// ============================================================
// 9. GROQ INTEGRATION
// ============================================================

export interface GroqFact {
  entity: string;
  attribute: string;
  value: string;
  type: string;
  state: string;
  scope: string | null;
  confidence: number;
  /** Smallest relevant clause/sentence — never the entire user message. */
  rawText: string;
  metadata?: Record<string, string> | null;
}

export interface GroqFactInput {
  facts: GroqFact[];
}

/** Strict JSON schema for Groq response validation. */
export const GROQ_FACT_SCHEMA = {
  type: "object" as const,
  required: ["facts"],
  additionalProperties: false as const,
  properties: {
    facts: {
      type: "array" as const,
      items: {
        type: "object" as const,
        required: [
          "entity",
          "attribute",
          "value",
          "type",
          "state",
          "scope",
          "confidence",
          "rawText",
          "metadata",
        ],
        additionalProperties: false as const,
        properties: {
          entity: { type: "string" as const },
          attribute: {
            type: "string" as const,
            enum: [
              "name",
              "occupation",
              "project",
              "uses",
              "database",
              "preference",
              "dislike",
              "experiment",
              "goal",
              "plan",
            ],
          },
          value: { type: "string" as const },
          type: {
            type: "string" as const,
            enum: [
              "identity", "usage", "past_usage", "stopped_usage", "preference",
              "dislike", "favorite", "goal", "plan", "possible_plan",
              "decision", "event", "temporary",
            ],
          },
          state: {
            type: "string" as const,
            enum: ["current", "past", "planned", "possible", "conditional", "stopped", "superseded"],
          },
          scope: { type: ["string", "null"] as const },
          confidence: { type: "number" as const },
          rawText: { type: "string" as const },
          metadata: {
            type: ["object", "null"] as const,
            additionalProperties: false as const,
            required: ["preferred_over", "condition", "reason"],
            properties: {
              preferred_over: { type: ["string", "null"] as const },
              condition: { type: ["string", "null"] as const },
              reason: { type: ["string", "null"] as const },
            },
          },
        },
      },
    },
  },
};

/** Allowed attributes after local normalization — inventing others is rejected. */
export const CANONICAL_ATTRIBUTES: ReadonlySet<string> = new Set([
  "name",
  "occupation",
  "project",
  "uses",
  "database",
  "preference",
  "dislike",
  "experiment",
  "goal",
  "plan",
]);

/** Loose aliases → one of CANONICAL_ATTRIBUTES. Unmapped → reject. */
export const CANONICAL_ATTRIBUTE_MAP: ReadonlyMap<string, string> = new Map([
  ["name", "name"],
  ["full_name", "name"],
  ["fullname", "name"],
  ["occupation", "occupation"],
  ["job", "occupation"],
  ["role", "occupation"],
  ["profession", "occupation"],
  ["title", "occupation"],
  ["project", "project"],
  ["project_name", "project"],
  ["uses", "uses"],
  ["usage", "uses"],
  ["technology", "uses"],
  ["tech", "uses"],
  ["tool", "uses"],
  ["stack", "uses"],
  ["runtime", "uses"],
  ["hosting", "uses"],
  ["platform", "uses"],
  ["framework", "uses"],
  ["frontend", "uses"],
  ["frontend_framework", "uses"],
  ["cache", "uses"],
  ["caching", "uses"],
  ["storage", "uses"],
  ["language", "uses"],
  ["editor", "uses"],
  ["decision", "uses"],
  ["database", "database"],
  ["db", "database"],
  ["preference", "preference"],
  ["prefer", "preference"],
  ["favorite", "preference"],
  ["favourite", "preference"],
  ["ui_library", "preference"],
  ["dislike", "dislike"],
  ["avoid", "dislike"],
  ["hate", "dislike"],
  ["experiment", "experiment"],
  ["temporary", "experiment"],
  ["temporary_state", "experiment"],
  ["testing", "experiment"],
  ["goal", "goal"],
  ["objective", "goal"],
  ["plan", "plan"],
]);

/** User-owned attributes — entity must always be "user". */
const USER_OWNED_ATTRIBUTES: ReadonlySet<string> = new Set([
  "name",
  "occupation",
  "preference",
  "dislike",
  "goal",
  "plan",
  "experiment",
]);

const SINGLE_VALUE_ATTRIBUTES: ReadonlySet<string> = new Set([
  "name",
  "occupation",
  "project",
]);

const TEMPORARY_HINT_RE =
  /\b(?:testing|trying|experimenting|debugging|checking|looking\s+at|learning\s+about|playing\s+with|evaluating)\b/i;

const PROJECT_SCOPE_HINT_RE =
  /\b(?:for\s+my\s+project|in\s+my\s+project|on\s+my\s+project|my\s+project\s+uses|for\s+the\s+project|in\s+the\s+project|called\s+\w+|for\s+[A-Z][A-Za-z0-9_-]+)\b/i;

const CONDITIONAL_HINT_RE =
  /\b(?:if|unless|provided\s+that|depending\s+on|only\s+if)\b/i;

const PROJECT_NAME_RE =
  /\b(?:project\s+called|building(?:\s+an?)?(?:\s+\w+)*\s+called|app\s+called|named)\s+([A-Z][A-Za-z0-9_-]+)/i;

/**
 * Create a Groq-based fact extractor.
 * Uses the groq-sdk client. The API key is injected for testability.
 */
export function createGroqExtractor(options: {
  baseUrl: string;
  apiKey: string;
  model?: string;
  timeout?: number;
  fetchImpl?: typeof fetch;
}): GroqExtractor {
  return new GroqExtractor(options);
}

export class GroqExtractor {
  private client: Groq;
  private model: string;
  private timeout: number;

  constructor(options: {
    baseUrl: string;
    apiKey: string;
    model?: string;
    timeout?: number;
    fetchImpl?: typeof fetch;
  }) {
    // The SDK already appends "/openai/v1" to the baseURL, so callers may pass
    // either the bare host (https://api.groq.com) or the OpenAI-compatible URL
    // (https://api.groq.com/openai/v1). Normalize to the bare host.
    const bareHost = options.baseUrl
      .replace(/\/+$/, "")
      .replace(/\/openai\/v1$/, "");
    this.client = new Groq({
      apiKey: options.apiKey,
      baseURL: bareHost,
      timeout: options.timeout || 10000,
      maxRetries: 0,
      fetch: options.fetchImpl,
    });
    this.model = options.model || "openai/gpt-oss-20b";
    this.timeout = options.timeout || 10000;
  }

  private async postChat(
    messages: ChatCompletionMessageParam[],
  ): Promise<string> {
    const completion = await this.client.chat.completions.create(
      {
        model: this.model,
        messages,
        temperature: 0,
        reasoning_effort: "low",
        include_reasoning: false,
        seed: 42,
        max_tokens: 1024,
        stream: false,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "facts_extraction",
            strict: true,
            schema: GROQ_FACT_SCHEMA as unknown as Record<string, unknown>,
          },
        },
      },
      { timeout: this.timeout },
    );
    return String(completion.choices?.[0]?.message?.content || "");
  }

  async extract(text: string): Promise<StructuredFact[]> {
    const systemPrompt = `You are Remember's memory extraction engine.

Your job is NOT to answer the user.
Extract only explicit, useful, potentially persistent information from the user's message.
Never invent facts. If nothing durable is stated, return {"facts":[]}.

ATOMICITY
- One fact = one piece of information.
- Split technology lists into separate facts.
- Example: "Cloudflare Workers with D1 and Redis" → three facts with attribute "uses".

ENTITY RULES
- Personal facts MUST use entity "user". Never use the user's name as entity.
- Project facts use the actual project name as entity when known (e.g. "MemoryBox"), else "project".
- Pronouns like "it/this/that/the project" → the known project name or "project".

CANONICAL ATTRIBUTES (ONLY these — never invent others)
name | occupation | location | project | uses | database | preference | dislike | experiment | goal | plan

STATE / TYPE RULES
- "I use X" → type "usage", attribute "uses", state "current"
- "I used X" → type "past_usage", attribute "uses", state "past"
- "I stopped using X because Y" → type "stopped_usage", attribute "uses", state "stopped", metadata.reason = Y
- "I plan to use X" → type "plan", attribute "plan", state "planned"
- "I want to …" → type "goal", attribute "goal", state "planned"
- "I might switch to X if Y" → attribute "plan", state "conditional" or "possible"; put Y in metadata.condition; do NOT emit a separate fact for the condition
- "I am experimenting/testing/trying X" → attribute "experiment" (NOT permanent uses)
- Explicit database choice may use attribute "database"; otherwise stack items use "uses"

PREFERENCES / DISLIKES
- "I prefer A over B" → attribute "preference", value A, metadata.preferred_over = B
- Never embed comparisons into value
- "I don't like X" / "I avoid X" / "I hate X" → one attribute "dislike" fact (no duplicates)

rawText
- Smallest relevant sentence or clause only
- NEVER the entire multi-sentence user message

IGNORE
- questions, requests, suggestions, greetings, thanks, jokes, filler, coding tasks

metadata fields (null when unused): preferred_over, condition, reason

Return only the required JSON object.`;

    const userPrompt = `Extract memory facts from this message:\n\n${text}`;

    const startedAt = Date.now();
    try {
      const rawResponse = await this.postChat([
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ]);
      const elapsed = Date.now() - startedAt;
      const facts = this.parseAndValidate(rawResponse, text);
      info("groq", "connection OK", {
        model: this.model,
        baseUrl: this.client.baseURL,
        ms: elapsed,
        facts: facts.length,
        source: text,
      });
      return facts;
    } catch (err) {
      const elapsed = Date.now() - startedAt;
      warn("groq", "connection FAILED (falling back to local)", {
        model: this.model,
        baseUrl: this.client.baseURL,
        ms: elapsed,
        error: err instanceof Error ? err.message : String(err),
        source: text,
      });
      return [];
    }
  }

  private parseAndValidate(responseText: string, sourceText: string): StructuredFact[] {
    try {
      const clean = responseText.trim();
      const parsed = JSON.parse(clean);
      const data: GroqFactInput = parsed.facts ? parsed : parsed;

      if (!data.facts || !Array.isArray(data.facts)) return [];

      const facts: StructuredFact[] = [];

      for (const item of data.facts) {
        if (!item || typeof item !== "object") continue;

        const entity = String(item.entity || "").trim();
        const attribute = String(item.attribute || "").trim();
        const value = String(item.value || "").trim();
        const type = String(item.type || "fact");
        const state = String(item.state || "current");
        const rawScope =
          item.scope === null || item.scope === undefined ? null : String(item.scope);
        const scope =
          rawScope === "project" || rawScope === "session" ? rawScope : "user";
        const confidence = Number(item.confidence);
        const itemRaw = String(item.rawText || "").trim();

        if (!entity || !attribute || !value) continue;
        if (INVALID_KEYS.has(attribute.toLowerCase())) continue;
        if (isNaN(confidence) || confidence < 0 || confidence > 1) continue;

        const mtype = mapGroqType(type);
        if (!mtype) continue;
        const fstate = mapGroqState(state);

        const metadata = normalizeGroqMetadata(item.metadata);

        // Never default rawText to the entire source here — validation picks the clause
        facts.push({
          entity,
          attribute,
          value,
          memoryType: mtype,
          rawText: itemRaw,
          key: `${scope}.${slugify(attribute)}`,
          scope: scope as "user" | "project" | "session",
          state: fstate,
          confidence,
          metadata,
          route: "groq",
        });
      }

      return applyLocalSemanticValidation(facts, sourceText);
    } catch {
      return [];
    }
  }
}

export function mapGroqType(type: string): MemoryType | null {
  const map: Record<string, MemoryType> = {
    identity: MemoryType.FACT,
    fact: MemoryType.FACT,
    preference: MemoryType.PREFERENCE,
    dislike: MemoryType.PREFERENCE,
    favorite: MemoryType.PREFERENCE,
    goal: MemoryType.GOAL,
    plan: MemoryType.GOAL,
    possible_plan: MemoryType.GOAL,
    decision: MemoryType.DECISION,
    usage: MemoryType.FACT,
    past_usage: MemoryType.FACT,
    stopped_usage: MemoryType.FACT,
    temporary: MemoryType.TEMPORARY_STATE,
    event: MemoryType.IMPORTANT_EVENT,
    action: MemoryType.IMPORTANT_EVENT,
    architecture: MemoryType.ARCHITECTURE,
    constraint: MemoryType.CONSTRAINT,
    active_task: MemoryType.ACTIVE_TASK,
  };
  return map[type] || null;
}

export function mapGroqState(state: string): FactState {
  const map: Record<string, FactState> = {
    current: "current",
    present: "current",
    past: "past",
    planned: "planned",
    future: "planned",
    possible: "possible",
    uncertain: "possible",
    conditional: "conditional",
    stopped: "stopped",
    discontinued: "stopped",
    superseded: "superseded",
  };
  return map[state] || "current";
}

function normalizeGroqMetadata(
  raw: GroqFact["metadata"] | Record<string, unknown> | null | undefined,
): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Record<string, string> = {};
  const src = raw as Record<string, unknown>;
  // Accept both preferred_over and legacy "over"
  for (const [from, to] of [
    ["preferred_over", "preferred_over"],
    ["over", "preferred_over"],
    ["condition", "condition"],
    ["reason", "reason"],
  ] as const) {
    const v = src[from];
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (s) out[to] = s;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// ============================================================
// 10. VALIDATION & NORMALIZATION
// ============================================================

/**
 * Map an attribute to a canonical name, or null if it must be rejected.
 * Never invent new attribute names outside CANONICAL_ATTRIBUTES.
 */
export function canonicalizeAttribute(attribute: string): string | null {
  const raw = normalizePreferenceSpelling(attribute).trim();
  const slug = slugify(raw);
  if (!slug) return null;

  // Normalize legacy negative prefixes only
  if (slug.startsWith("disliked_")) return "dislike";

  const mapped = CANONICAL_ATTRIBUTE_MAP.get(slug);
  if (mapped && CANONICAL_ATTRIBUTES.has(mapped)) return mapped;
  if (CANONICAL_ATTRIBUTES.has(slug)) return slug;
  return null;
}

/** Stable dedupe identity for a fact (allows multiple uses values). */
export function factIdentityKey(fact: StructuredFact): string {
  const scope = fact.scope || scopeForFact(fact);
  const attr = slugify(fact.attribute);
  const state = fact.state || "current";
  if (SINGLE_VALUE_ATTRIBUTES.has(attr)) {
    return `${scope}|${attr}`;
  }
  return `${scope}|${attr}|${slugify(fact.value)}|${state}`;
}

/**
 * Pick the smallest clause/sentence from source that mentions the value.
 * Never returns the entire multi-sentence message when a smaller clause exists.
 */
export function findSmallestRawText(
  sourceText: string,
  value: string,
  preferredRaw?: string,
): string {
  const source = sourceText.trim();
  if (!source) return (preferredRaw || "").trim();

  const clauses = splitSentencesByBoundary(source);
  const multiSentence = clauses.length > 1 || /[.!?].+\S/.test(source);

  const preferred = (preferredRaw || "").trim();
  if (
    preferred &&
    preferred.length > 0 &&
    preferred.length < source.length &&
    source.toLowerCase().includes(preferred.toLowerCase())
  ) {
    // Prefer Groq clause only if it is not the whole message
    if (!(multiSentence && preferred === source)) {
      return preferred;
    }
  }

  const valueLower = value.toLowerCase();
  const valueTokens = valueLower.match(/[a-z0-9+#.-]+/g) || [];

  const scored = clauses
    .map((clause) => {
      const lower = clause.toLowerCase();
      const hit =
        lower.includes(valueLower) ||
        (valueTokens.length > 0 && valueTokens.every((t) => lower.includes(t)));
      return hit ? clause.trim() : null;
    })
    .filter((c): c is string => Boolean(c));

  if (scored.length > 0) {
    scored.sort((a, b) => a.length - b.length);
    return scored[0]!;
  }

  // Last resort: first clause — never the full multi-sentence blob
  if (clauses.length > 0) return clauses[0]!.trim();
  return source;
}

/** Detect project name from source text or existing facts. */
export function detectProjectName(
  sourceText: string,
  facts: StructuredFact[] = [],
): string | null {
  for (const f of facts) {
    const attr = canonicalizeAttribute(f.attribute);
    if (attr === "project" && f.value.trim()) return cleanVal(f.value);
    if (
      attr === "project" ||
      (f.scope === "project" &&
        f.entity &&
        !["user", "project", "session"].includes(f.entity.toLowerCase()))
    ) {
      if (f.entity && !["user", "project", "session", "my"].includes(f.entity.toLowerCase())) {
        return f.entity.trim();
      }
    }
  }
  const m = sourceText.match(PROJECT_NAME_RE);
  if (m?.[1]) return cleanVal(m[1]);
  // "for MemoryBox" / "in MemoryBox"
  const forProj = sourceText.match(/\b(?:for|in|on)\s+([A-Z][A-Za-z0-9_-]{2,})\b/);
  if (forProj?.[1] && !["I", "I'"].includes(forProj[1])) {
    const name = forProj[1];
    if (!TECH_KEYWORDS.has(name.toLowerCase())) return name;
  }
  return null;
}

/** Split compound tech values into atomic "uses" (or database) facts. */
export function splitAtomicUsageValues(value: string): Array<{ attr: string; value: string }> {
  const cleaned = cleanVal(value);
  if (!cleaned) return [];

  const clauses = splitClauses(cleaned);
  const parts = clauses.length <= 1 ? [cleaned] : clauses;

  const out: Array<{ attr: string; value: string }> = [];
  const seen = new Set<string>();
  for (const clause of parts) {
    const inferred = inferAttributeFromClause(clause);
    const val = cleanVal(inferred.value);
    if (!val) continue;
    // Strict: stack items → uses; only clear DB purpose → database
    let attr = "uses";
    if (
      inferred.attr === "database" ||
      (attributeForValue(val) === "database" && /\b(database|db|d1|postgres|neon|turso|sqlite)\b/i.test(clause))
    ) {
      // User example wants D1 as uses when listed with Workers/Redis.
      // Only promote to database when purpose says so ("as the database" / "for database").
      if (/\b(?:as|for)\s+(?:the\s+)?(?:database|db)\b/i.test(clause)) {
        attr = "database";
      }
    }
    const id = `${attr}|${val.toLowerCase()}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ attr, value: val });
  }
  return out.length > 0 ? out : [{ attr: "uses", value: cleaned }];
}

function extractComparison(value: string): { value: string; preferred_over?: string } {
  const m = value.match(/^(.+?)\s+over\s+(.+)$/i) || value.match(/^(.+?)\s+than\s+(.+)$/i);
  if (!m || !m[1] || !m[2]) return { value: cleanVal(value) };
  return { value: cleanVal(m[1]), preferred_over: cleanVal(m[2]) };
}

function extractCondition(text: string): string | undefined {
  const m = text.match(/\b(?:if|unless|provided\s+that|depending\s+on|only\s+if)\s+(.+)$/i);
  if (!m || !m[1]) return undefined;
  return cleanVal(m[1].replace(/\s*[.!?]+$/, ""));
}

function extractStoppedReason(text: string): string | undefined {
  const m = text.match(/\b(?:because|due\s+to|since)\s+(.+)$/i);
  if (!m || !m[1]) return undefined;
  return cleanVal(m[1].replace(/\s*[.!?]+$/, ""));
}

function isUserOwnedFact(fact: StructuredFact): boolean {
  const attr = canonicalizeAttribute(fact.attribute) || fact.attribute;
  if (USER_OWNED_ATTRIBUTES.has(attr)) return true;
  if (
    fact.memoryType === MemoryType.PREFERENCE ||
    fact.memoryType === MemoryType.GOAL ||
    fact.memoryType === MemoryType.TEMPORARY_STATE
  ) {
    return true;
  }
  return false;
}

function looksLikePersonName(entity: string, knownNames: Set<string>): boolean {
  const e = entity.trim();
  if (!e) return false;
  if (["user", "project", "session", "my", "we", "our"].includes(e.toLowerCase())) return false;
  if (knownNames.has(e.toLowerCase())) return true;
  if (TECH_KEYWORDS.has(e.toLowerCase())) return false;
  const parts = e.split(/\s+/);
  if (parts.length >= 2 && parts.every((p) => /^[A-Z][a-z'-]*$/.test(p))) return true;
  // Single capitalized token that matches a known name value
  if (parts.length === 1 && knownNames.has(e.toLowerCase())) return true;
  return false;
}

function memoryTypeForAttribute(attr: string, state: FactState): MemoryType {
  switch (attr) {
    case "preference":
    case "dislike":
      return MemoryType.PREFERENCE;
    case "goal":
    case "plan":
      return MemoryType.GOAL;
    case "experiment":
      return MemoryType.TEMPORARY_STATE;
    case "database":
      return MemoryType.DECISION;
    case "uses":
      return state === "planned" || state === "possible" || state === "conditional"
        ? MemoryType.GOAL
        : MemoryType.FACT;
    default:
      return MemoryType.FACT;
  }
}

function deriveKeyForFact(fact: StructuredFact): string {
  const scope = fact.scope || scopeForFact(fact);
  const attr = slugify(fact.attribute);
  if (fact.attribute === "project") return "project.name";
  if (SINGLE_VALUE_ATTRIBUTES.has(attr)) return `${scope}.${attr}`;
  return `${scope}.${attr}.${slugify(fact.value)}`;
}

function finalizeFact(
  fact: Omit<StructuredFact, "key"> & { key?: string },
  source: string,
): StructuredFact | null {
  const attribute = canonicalizeAttribute(fact.attribute);
  if (!attribute) return null;
  const value = cleanVal(fact.value);
  if (!value || INVALID_KEYS.has(value.toLowerCase())) return null;

  const state = fact.state || "current";
  const scope = fact.scope || "user";
  let entity = (fact.entity || "user").trim();

  if (USER_OWNED_ATTRIBUTES.has(attribute) || scope === "user") {
    if (attribute !== "project" && attribute !== "uses" && attribute !== "database") {
      entity = "user";
    }
  }
  if (USER_OWNED_ATTRIBUTES.has(attribute)) {
    entity = "user";
  }

  const rawText = findSmallestRawText(source, value, fact.rawText);
  // Hard rule: never keep full multi-sentence source as rawText
  if (rawText === source.trim() && splitSentencesByBoundary(source).length > 1) {
    return null; // cannot anchor — drop rather than store whole message
  }

  const out: StructuredFact = {
    ...fact,
    entity,
    attribute,
    value,
    memoryType: memoryTypeForAttribute(attribute, state),
    scope: attribute === "experiment" ? "session" : (scope as "user" | "project" | "session"),
    state,
    rawText,
    metadata: fact.metadata && Object.keys(fact.metadata).length ? fact.metadata : undefined,
    key: "",
  };
  if (attribute === "project") {
    out.scope = "project";
    out.entity = value;
  }
  out.key = deriveKeyForFact(out);
  return out;
}

/**
 * Apply local semantic validation to Groq (or merged) facts:
 * strict canonical attributes, entity rules, atomic uses splits,
 * preference/dislike/plan normalization, clause-level rawText, dedupe.
 */
export function applyLocalSemanticValidation(
  facts: StructuredFact[],
  originalText: string,
): StructuredFact[] {
  const source = originalText.trim();
  const knownNames = new Set<string>();
  const projectName = detectProjectName(source, facts);

  for (const f of facts) {
    if (canonicalizeAttribute(f.attribute) === "name" && f.value) {
      knownNames.add(f.value.toLowerCase());
      knownNames.add(f.entity.toLowerCase());
    }
  }

  const projectScoped =
    PROJECT_SCOPE_HINT_RE.test(source) || Boolean(projectName);
  const expanded: StructuredFact[] = [];

  for (const raw of facts) {
    if (!raw || !raw.value?.trim() || !raw.attribute?.trim()) continue;
    if (raw.value.trim().endsWith("?")) continue;
    if (INVALID_KEYS.has(raw.attribute.toLowerCase())) continue;

    let attribute = canonicalizeAttribute(raw.attribute);
    // Never invent attributes — unmapped names are rejected
    if (!attribute) continue;

    let fact: StructuredFact = {
      ...raw,
      attribute,
      metadata: raw.metadata ? { ...raw.metadata } : undefined,
    };
    let state = fact.state || "current";
    let scope: "user" | "project" | "session" = fact.scope || "user";
    let entity = fact.entity.trim();
    const valueClause = findSmallestRawText(source, fact.value, fact.rawText);

    // Experiment / temporary — never permanent uses
    if (
      attribute === "experiment" ||
      TEMPORARY_HINT_RE.test(valueClause) ||
      fact.memoryType === MemoryType.TEMPORARY_STATE
    ) {
      if (
        attribute === "uses" ||
        attribute === "database" ||
        TEMPORARY_HINT_RE.test(valueClause) ||
        fact.memoryType === MemoryType.TEMPORARY_STATE
      ) {
        const finalized = finalizeFact(
          {
            ...fact,
            entity: "user",
            attribute: "experiment",
            state: "current",
            scope: "session",
            rawText: valueClause,
          },
          source,
        );
        if (finalized) expanded.push(finalized);
        continue;
      }
    }

    // Drop questions / requests — never invent from interrogatives
    if (
      valueClause.trim().endsWith("?") ||
      isInterrogative(valueClause) ||
      /^(?:what|why|how|when|where|who|which|should|can|could|would)\b/i.test(valueClause.trim())
    ) {
      continue;
    }

    // Preferences
    if (
      (attribute === "preference" || fact.memoryType === MemoryType.PREFERENCE) &&
      attribute !== "dislike"
    ) {
      const cmp = extractComparison(fact.value);
      const meta: Record<string, string> = { ...(fact.metadata || {}) };
      if (cmp.preferred_over) meta.preferred_over = cmp.preferred_over;
      if (meta.over && !meta.preferred_over) {
        meta.preferred_over = meta.over;
        delete meta.over;
      }
      const finalized = finalizeFact(
        {
          ...fact,
          entity: "user",
          attribute: "preference",
          value: cmp.value,
          state: "current",
          scope: "user",
          metadata: meta,
          rawText: valueClause,
        },
        source,
      );
      if (finalized) expanded.push(finalized);
      continue;
    }

    // Dislikes — one normalized dislike
    if (
      attribute === "dislike" ||
      /\b(?:don'?t|do\s+not)\s+(?:really\s+)?(?:like|love|enjoy)|hate|dislike|avoid\b/i.test(valueClause)
    ) {
      // If this was mis-tagged as current uses under negation → dislike
      const finalized = finalizeFact(
        {
          ...fact,
          entity: "user",
          attribute: "dislike",
          value: cleanVal(fact.value.replace(/\s+anymore\s*$/i, "")),
          state: "current",
          scope: "user",
          rawText: valueClause,
          metadata: undefined,
        },
        source,
      );
      if (finalized) expanded.push(finalized);
      continue;
    }

    // Goals / plans (+ conditional attach)
    if (attribute === "goal" || attribute === "plan" || fact.memoryType === MemoryType.GOAL) {
      const meta: Record<string, string> = { ...(fact.metadata || {}) };
      let value = fact.value.replace(/\s+\b(?:if|unless)\b.+$/i, "").trim();
      value = cleanVal(value.replace(/^(?:use|using|to\s+use|switch\s+to)\s+/i, "") || value);

      // Reject condition-only fragments pretending to be goals
      if (
        /^(?:latency|pricing|cost|performance)\b/i.test(value) ||
        /^if\b/i.test(valueClause.trim()) ||
        (meta.condition && value.toLowerCase() === meta.condition.toLowerCase())
      ) {
        continue;
      }

      if (
        state === "possible" ||
        state === "conditional" ||
        CONDITIONAL_HINT_RE.test(valueClause)
      ) {
        const cond = meta.condition || extractCondition(valueClause);
        if (cond) meta.condition = cond;
        if (state !== "possible") state = "conditional";
        attribute = "plan";
      } else if (attribute === "plan" || /\bplan\b/i.test(valueClause)) {
        attribute = "plan";
        state = "planned";
      } else {
        attribute = "goal";
        state = "planned";
      }

      const finalized = finalizeFact(
        {
          ...fact,
          entity: "user",
          attribute,
          value: value || fact.value,
          state,
          scope: "user",
          metadata: meta,
          rawText: valueClause,
        },
        source,
      );
      if (finalized) expanded.push(finalized);
      continue;
    }

    // Name / occupation / project identity
    if (attribute === "name" || attribute === "occupation") {
      const finalized = finalizeFact(
        {
          ...fact,
          entity: "user",
          attribute,
          state: "current",
          scope: "user",
          rawText: valueClause,
        },
        source,
      );
      if (finalized) expanded.push(finalized);
      continue;
    }

    if (attribute === "project") {
      const finalized = finalizeFact(
        {
          ...fact,
          attribute: "project",
          value: cleanVal(fact.value),
          state: "current",
          scope: "project",
          entity: cleanVal(fact.value),
          rawText: valueClause,
        },
        source,
      );
      if (finalized) expanded.push(finalized);
      continue;
    }

    // Uses / database — past, stopped, current; split compounds
    if (attribute === "uses" || attribute === "database") {
      const meta = { ...(fact.metadata || {}) };

      if (/\bstopped\s+using\b|\bno\s+longer\s+use\b|\bdon'?t\s+use\b.*\banymore\b/i.test(valueClause)) {
        state = "stopped";
        const reason = meta.reason || extractStoppedReason(valueClause);
        if (reason) meta.reason = reason;
        // Strip reason from value if embedded
        fact = {
          ...fact,
          value: cleanVal(fact.value.replace(/\s+(?:because|due\s+to|since)\s+.+$/i, "")),
        };
      } else if (
        /\bused\s+to\s+use\b|\bpreviously\s+used\b|(?:^|\b)i\s+used\b/i.test(valueClause) &&
        !/\bnow\b/i.test(valueClause)
      ) {
        state = "past";
      } else if (extractNegation(valueClause) && state === "current") {
        // Negated like without dislike verbs already handled → stopped
        state = "stopped";
      } else {
        state = state === "past" || state === "stopped" ? state : "current";
      }

      const parts =
        /,&|\band\b|\bwith\b/i.test(fact.value) || attribute === "uses"
          ? splitAtomicUsageValues(fact.value)
          : [{ attr: attribute, value: cleanVal(fact.value) }];

      // If single non-compound database, keep as database
      const useParts =
        attribute === "database" && parts.length === 1
          ? [{ attr: "database", value: parts[0]!.value }]
          : parts;

      const entityForProject =
        projectName ||
        (projectScoped
          ? "project"
          : looksLikePersonName(entity, knownNames) || entity.toLowerCase() === "user"
            ? projectName || "project"
            : PRONOUN_SUBJECTS.has(entity.toLowerCase())
              ? projectName || "project"
              : entity);

      const scopedToProject =
        projectScoped ||
        scope === "project" ||
        Boolean(projectName) ||
        PRONOUN_SUBJECTS.has(entity.toLowerCase());

      for (const part of useParts) {
        const partAttr = canonicalizeAttribute(part.attr) || "uses";
        if (partAttr !== "uses" && partAttr !== "database") continue;

        const finalized = finalizeFact(
          {
            entity: scopedToProject ? entityForProject : "user",
            attribute: partAttr,
            value: part.value,
            memoryType: MemoryType.FACT,
            state,
            scope: scopedToProject ? "project" : "user",
            confidence: fact.confidence,
            metadata: Object.keys(meta).length ? meta : undefined,
            rawText: findSmallestRawText(source, part.value, valueClause),
          },
          source,
        );
        if (finalized) {
          // Personal uses (no project context) stay on user
          if (!scopedToProject) {
            finalized.entity = "user";
            finalized.scope = "user";
            finalized.key = deriveKeyForFact(finalized);
          } else if (looksLikePersonName(finalized.entity, knownNames)) {
            finalized.entity = projectName || "project";
            finalized.key = deriveKeyForFact(finalized);
          }
          expanded.push(finalized);
        }
      }
      continue;
    }

    // Fallback — only if still canonical
    const finalized = finalizeFact(
      {
        ...fact,
        entity: isUserOwnedFact(fact)
          ? "user"
          : looksLikePersonName(entity, knownNames)
            ? "user"
            : entity,
        attribute,
        state,
        scope,
        rawText: valueClause,
      },
      source,
    );
    if (finalized) expanded.push(finalized);
  }

  // Drop condition-only / invalid / whole-message rawText
  const filtered = expanded.filter((f) => {
    if (!f.value) return false;
    if (!CANONICAL_ATTRIBUTES.has(f.attribute)) return false;
    if (f.attribute === "condition") return false;
    const clauses = splitSentencesByBoundary(source);
    if (clauses.length > 1 && f.rawText.trim() === source) return false;
    return true;
  });

  return deduplicateFacts(resolveEntities(filtered, knownNames, projectName));
}

/** Deduplicate facts by semantic identity. */
export function deduplicateFacts(facts: StructuredFact[]): StructuredFact[] {
  const seen = new Map<string, StructuredFact>();
  for (const fact of facts) {
    const key = factIdentityKey(fact);
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, fact);
      continue;
    }
    const keep =
      (fact.confidence || 0) > (existing.confidence || 0) ? fact : existing;
    const drop = keep === fact ? existing : fact;
    if (drop.metadata || keep.metadata) {
      const mergedMeta: Record<string, string> = {
        ...(drop.metadata || {}),
        ...(keep.metadata || {}),
      };
      if (mergedMeta.over && !mergedMeta.preferred_over) {
        mergedMeta.preferred_over = mergedMeta.over;
        delete mergedMeta.over;
      }
      keep.metadata = mergedMeta;
    }
    keep.key = deriveKeyForFact(keep);
    seen.set(key, keep);
  }

  // Collapse duplicate dislikes for the same value
  const byDislike = new Map<string, StructuredFact>();
  const out: StructuredFact[] = [];
  for (const fact of seen.values()) {
    if (fact.attribute === "dislike") {
      const vk = slugify(fact.value);
      if (byDislike.has(vk)) continue;
      byDislike.set(vk, fact);
    }
    out.push(fact);
  }
  return out;
}

/** Normalize entity names to canonical form. */
export function resolveEntities(
  facts: StructuredFact[],
  knownNames: Set<string> = new Set(),
  projectName: string | null = null,
): StructuredFact[] {
  const entityMap: Record<string, string> = {
    it: projectName || "project",
    this: projectName || "project",
    that: projectName || "project",
    "the project": projectName || "project",
    "the app": projectName || "project",
    "the system": projectName || "project",
    project: projectName || "project",
    we: "user",
    our: "user",
    my: "user",
  };

  for (const fact of facts) {
    if (canonicalizeAttribute(fact.attribute) === "name") {
      knownNames.add(fact.value.toLowerCase());
    }
  }

  for (const fact of facts) {
    const lower = fact.entity.toLowerCase();
    if (entityMap[lower]) {
      fact.entity = entityMap[lower];
    }
    if (knownNames.has(lower) || looksLikePersonName(fact.entity, knownNames)) {
      if (USER_OWNED_ATTRIBUTES.has(fact.attribute) || fact.scope === "user") {
        fact.entity = "user";
      } else if (fact.scope === "project") {
        fact.entity = projectName || "project";
      } else {
        fact.entity = "user";
      }
    }
    if (USER_OWNED_ATTRIBUTES.has(fact.attribute)) {
      fact.entity = "user";
      if (fact.attribute !== "experiment") fact.scope = "user";
    }
    if (fact.attribute === "project") {
      fact.scope = "project";
      fact.entity = fact.value;
    }
    if (
      (fact.attribute === "uses" || fact.attribute === "database") &&
      fact.scope === "project" &&
      (fact.entity === "project" || looksLikePersonName(fact.entity, knownNames)) &&
      projectName
    ) {
      fact.entity = projectName;
    }
    fact.key = deriveKeyForFact(fact);
  }
  return facts;
}

/**
 * Merge local facts with Groq facts, deduplicate, and normalize.
 */
export function mergeFacts(
  localFacts: StructuredFact[],
  groqFacts: StructuredFact[],
): StructuredFact[] {
  // Re-validate the union so local invented attrs (technology, etc.) are normalized
  const source =
    groqFacts[0]?.rawText ||
    localFacts[0]?.rawText ||
    "";
  // Prefer applying validation when we have source context from either side
  const all = [...localFacts, ...groqFacts];
  if (source && splitSentencesByBoundary(source).length >= 1) {
    // Use longest rawText as source approximation when merging without original
    const longest = all.reduce((a, b) => (a.rawText.length >= b.rawText.length ? a : b)).rawText;
    // If local facts already have short rawText, just resolve+dedupe after soft canonicalize
    const normalized = all
      .map((f) => {
        const attr = canonicalizeAttribute(f.attribute);
        if (!attr) return null;
        const copy = { ...f, attribute: attr };
        if (USER_OWNED_ATTRIBUTES.has(attr)) {
          copy.entity = "user";
          if (attr !== "experiment") copy.scope = "user";
        }
        if (copy.metadata?.over && !copy.metadata.preferred_over) {
          copy.metadata = {
            ...copy.metadata,
            preferred_over: copy.metadata.over,
          };
          delete copy.metadata.over;
        }
        copy.key = deriveKeyForFact(copy);
        return copy;
      })
      .filter((f): f is StructuredFact => f !== null);
    return deduplicateFacts(resolveEntities(normalized));
  }
  return deduplicateFacts(resolveEntities(all));
}

// ============================================================
// 11. HYBRID EXTRACTION (async)
// ============================================================

export interface HybridExtractionResult {
  route: "local" | "groq" | "skip";
  confidence: number;
  facts: StructuredFact[];
}

export interface HybridExtractionOptions {
  groqBaseUrl?: string;
  groqApiKey?: string;
  groqModel?: string;
  forceLocal?: boolean;
  forceGroq?: boolean;
  fetchImpl?: typeof fetch;
}

/**
 * High-level hybrid extraction function.
 * 1. Normalize input
 * 2. Detect obvious non-memory → skip
 * 3. Run local extractors
 * 4. If high confidence → return local facts
 * 5. If ambiguous → call Groq
 * 6. Validate Groq JSON
 * 7. Merge local + Groq facts
 * 8. Deduplicate
 * 9. Return StructuredFact[]
 */
export async function extractStructuredFactsHybrid(
  text: string,
  options: HybridExtractionOptions = {}
): Promise<HybridExtractionResult> {
  const cleaned = text.trim();
  if (!cleaned) {
    return { route: "skip", confidence: 0.99, facts: [] };
  }

  // Step 1: Gate
  const gate = shouldConsiderMemory(cleaned);

  // SKIP (unless tests force Groq)
  if (!options.forceGroq && !gate.shouldCallGroq && gate.candidateKinds.length === 0) {
    return { route: "skip", confidence: gate.confidence, facts: [] };
  }

  // Step 2: Local extraction
  const localResults = extractLocalFacts(cleaned);
  const localFacts: StructuredFact[] = localResults.map((r) => r.fact).filter((f): f is StructuredFact => f !== null);

  // If we have high-confidence local facts, return them (unless forceGroq)
  if (!options.forceGroq && localFacts.length > 0 && gate.confidence >= 0.9) {
    return {
      route: "local",
      confidence: gate.confidence,
      facts: localFacts,
    };
  }

  // Step 3: Check if we need Groq
  if (options.forceLocal || (!options.forceGroq && !gate.shouldCallGroq)) {
    return {
      route: "local",
      confidence: localFacts.length > 0 ? gate.confidence : 0.5,
      facts: localFacts,
    };
  }

  // Step 4: Call Groq
  const groqBaseUrl = options.groqBaseUrl || (typeof process !== "undefined" ? process.env.GROQ_BASE_URL : undefined) || "https://api.groq.com/openai/v1";
  const groqApiKey = options.groqApiKey || (typeof process !== "undefined" ? process.env.GROQ_API_KEY : undefined) || "";

  if (!groqApiKey) {
    // No Groq key configured, return local facts
    debug("groq", "connection SKIPPED: no GROQ_API_KEY configured", {
      baseUrl: groqBaseUrl,
    });
    return {
      route: "local",
      confidence: localFacts.length > 0 ? 0.7 : 0.3,
      facts: localFacts,
    };
  }

  const extractor = createGroqExtractor({
    baseUrl: groqBaseUrl,
    apiKey: groqApiKey,
    model: options.groqModel,
    fetchImpl: options.fetchImpl,
  });

  const groqFacts = await extractor.extract(cleaned);

  // Step 5: Validate Groq facts locally
  const validatedGroq = applyLocalSemanticValidation(groqFacts, cleaned);

  // Step 6: Merge
  const merged = mergeFacts(localFacts, validatedGroq);

  const route: "local" | "groq" = groqFacts.length > 0 ? "groq" : "local";
  const confidence = merged.length > 0
    ? Math.max(...merged.map((f) => f.confidence || 0.5))
    : 0.3;

  return { route, confidence, facts: merged };
}

// ============================================================
// 12. PRESERVED EXISTING SYNC API
// ============================================================

export function extractStructuredFact(text: string): StructuredFact | null {
  const cleaned = text.trim();
  if (!cleaned || isInterrogative(cleaned)) {
    return null;
  }

  return (
    extractBuilding(cleaned) ||
    extractLocation(cleaned) ||
    extractPossessive(cleaned) ||
    extractFavoriteIs(cleaned) ||
    extractPreference(cleaned) ||
    extractAffectPreference(cleaned) ||
    extractUses(cleaned) ||
    extractTheYIsX(cleaned) ||
    null
  );
}

export function extractStructuredFacts(text: string): StructuredFact[] {
  const cleaned = text.trim();
  if (!cleaned || isInterrogative(cleaned)) {
    return [];
  }

  const sentences = splitSentences(cleaned);
  if (sentences.length > 1) {
    const out: StructuredFact[] = [];
    const seen = new Set<string>();
    for (const sentence of sentences) {
      for (const fact of extractStructuredFacts(sentence)) {
        const k = fact.key || structuredFactToTopicKey(fact);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(fact);
      }
    }
    return out;
  }

  const multi = extractUsesList(cleaned);
  if (multi.length > 0) {
    return multi;
  }

  // Compound preference/name: "My name is X and I prefer Y" -> two facts.
  const compound = cleaned.match(/^(?<first>.+?)\s+and\s+I\s+prefer\s+(?<second>.+)$/i);
  if (compound && compound.groups) {
    const firstFacts = extractStructuredFact(compound.groups.first.trim());
    const secondFacts = extractStructuredFact(`I prefer ${compound.groups.second.trim()}`);
    const out: StructuredFact[] = [];
    if (firstFacts) out.push(firstFacts);
    if (secondFacts) out.push(secondFacts);
    if (out.length > 0) return out;
  }

  const single = extractStructuredFact(cleaned);
  return single ? [single] : [];
}
