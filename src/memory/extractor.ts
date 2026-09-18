import {
  MemoryType,
  type CandidateMemory,
  type StructuredFact,
  type Correction,
  type Revocation,
} from "../models/memory.js";
import { type NormalizedMessage } from "./ids.js";
import { isInterrogative } from "./interrogative.js";
import { isLowInfoMessage } from "./low-info.js";
import { info, debug } from "../log.js";
import {
  detectPreferenceDomain,
  extractStructuredFacts,
  extractStructuredFact,
  extractStructuredFactsHybrid,
  shouldConsiderMemory,
  slugify,
  splitSentences,
  structuredFactToContent,
  structuredFactToTopicKey,
  INVALID_KEYS,
} from "./facts.js";
import { parseCorrection, stripCorrectionPrefix } from "./correction.js";
import { parseRevocation } from "./revocation.js";
import {
  looksLikeCorrection,
  looksSpeculative,
  scoreCandidate,
} from "./scorer.js";

const PREFIX_RE =
  /^\s*(?:\[(?<bracket>[a-z_ ]+)\]|(?<label>[a-z_ ]+)\s*:)\s*(?<body>.+)$/is;

const LABEL_TO_TYPE: Record<string, MemoryType> = {
  fact: MemoryType.FACT,
  facts: MemoryType.FACT,
  decision: MemoryType.DECISION,
  decisions: MemoryType.DECISION,
  constraint: MemoryType.CONSTRAINT,
  constraints: MemoryType.CONSTRAINT,
  preference: MemoryType.PREFERENCE,
  preferences: MemoryType.PREFERENCE,
  goal: MemoryType.GOAL,
  goals: MemoryType.GOAL,
  architecture: MemoryType.ARCHITECTURE,
  important_event: MemoryType.IMPORTANT_EVENT,
  "important event": MemoryType.IMPORTANT_EVENT,
  event: MemoryType.IMPORTANT_EVENT,
  active_task: MemoryType.ACTIVE_TASK,
  "active task": MemoryType.ACTIVE_TASK,
  task: MemoryType.ACTIVE_TASK,
  todo: MemoryType.ACTIVE_TASK,
};

const KV_RE =
  /^\s*(?<key>[A-Za-z][\w\s/-]{0,40}?)\s*(?:=| is | are |:=|:)\s*(?<value>.+?)\s*$/i;

const DECISION_RE =
  /^\s*(?:we\s+)?(?:decided(?:\s+to)?|will\s+use|are\s+using|chose|picked|switched(?:\s+production)?\s+to|use)\s+(.+)$/i;

const CONSTRAINT_RE =
  /^\s*(?:(?:do\s+not|don't|never|must\s+not|cannot|can't|constraint)\b[:\s-]*)(.+)$/i;

const PREFERENCE_RE =
  /^\s*(?:i\s+)?(?:prefer|would\s+rather|preference)\b[:\s-]*(.+)$/i;

const GOAL_RE =
  /^\s*(?:goal|objective|we\s+need\s+to|aim\s+to)\b[:\s-]*(.+)$/i;

const TASK_RE =
  /^\s*(?:todo|task|working\s+on|next)\b[:\s-]*(.+)$/i;

const EVENT_RE =
  /^\s*(?:deployed|shipped|launched|released|incident)\b[:\s-]*(.+)$/i;

const ARCH_RE =
  /^\s*(?:architecture|stack|system\s+design)\b[:\s-]*(.+)$/i;

export function topicKeyFromContent(content: string, memoryType?: MemoryType | null): string {
  if (memoryType === MemoryType.PREFERENCE) {
    const [, prefTopic] = detectPreferenceDomain(content);
    return prefTopic;
  }

  const kv = content.trim().match(KV_RE);
  if (kv && kv.groups) {
    return slugify(kv.groups.key);
  }

  const decision = content.trim().match(DECISION_RE);
  if (decision) {
    const body = decision[1];
    const forMatch = body.match(/(.+?)\s+for\s+(.+)$/i);
    if (forMatch) {
      return slugify(forMatch[2]);
    }
    return slugify(body);
  }

  const tokens = content.toLowerCase().match(/[a-z0-9]+/g) || [];
  const stop = new Set([
    "we", "the", "a", "an", "to", "for", "and", "or", "of", "in", "on",
    "is", "are", "use", "using", "will", "decided", "our", "be",
  ]);
  const meaningful = tokens.filter((t) => !stop.has(t));
  if (meaningful.length === 0) {
    return slugify(content.slice(0, 48));
  }
  const head = meaningful.slice(0, 3);
  if (memoryType) {
    return `${memoryType}:${head.join("_")}`;
  }
  return head.join("_");
}

function authorityForRole(role: string, content: string): "user" | "assistant" | "speculation" {
  if (looksSpeculative(content)) {
    return "speculation";
  }
  if (role === "user") {
    return "user";
  }
  if (role === "assistant") {
    return "assistant";
  }
  return "speculation";
}

function parsePrefix(content: string): [MemoryType | null, string] {
  const match = content.match(PREFIX_RE);
  if (!match || !match.groups) {
    return [null, content];
  }
  const label = (match.groups.bracket || match.groups.label || "").trim().toLowerCase();
  const body = match.groups.body.trim();
  return [LABEL_TO_TYPE[label] || null, body];
}

function classify(content: string): [MemoryType, string, StructuredFact | null] | null {
  const [typed, body] = parsePrefix(content);
  if (typed !== null && body) {
    if (isInterrogative(body)) {
      return null;
    }
    const sfact = extractStructuredFact(body);
    return [typed, body, sfact];
  }

  if (isInterrogative(content)) {
    return null;
  }

  const sfact = extractStructuredFact(content);
  if (sfact !== null) {
    return [sfact.memoryType, structuredFactToContent(sfact), sfact];
  }

  const text = content.trim();
  const patterns: Array<[RegExp, MemoryType]> = [
    [CONSTRAINT_RE, MemoryType.CONSTRAINT],
    [PREFERENCE_RE, MemoryType.PREFERENCE],
    [GOAL_RE, MemoryType.GOAL],
    [TASK_RE, MemoryType.ACTIVE_TASK],
    [EVENT_RE, MemoryType.IMPORTANT_EVENT],
    [ARCH_RE, MemoryType.ARCHITECTURE],
    [DECISION_RE, MemoryType.DECISION],
  ];

  for (const [pattern, mtype] of patterns) {
    const m = text.match(pattern);
    if (m) {
      let b = m[1].trim();
      if (mtype === MemoryType.DECISION) {
        b = !b.toLowerCase().startsWith("use ") ? `Use ${b}` : b;
        b = b.length > 0 ? b[0].toUpperCase() + b.slice(1) : b;
      }
      return [mtype, b, null];
    }
  }

  const kv = text.match(KV_RE);
  if (kv && kv.groups) {
    const key = kv.groups.key.trim();
    const value = kv.groups.value.trim();
    if (value.endsWith("?") || INVALID_KEYS.has(key.toLowerCase())) {
      return null;
    }
    if (/\b(database|db|provider|stack|hosting)\b/i.test(key)) {
      return [MemoryType.DECISION, `${key} = ${value}`, null];
    }
    return [MemoryType.FACT, `${key} = ${value}`, null];
  }

  return null;
}

function buildCorrectionCandidate(
  message: NormalizedMessage,
  correction: Correction,
  text: string
): CandidateMemory | null {
  const targetLower = correction.target.toLowerCase();
  let mtype = MemoryType.FACT;
  let topicKey = "";
  let content = "";
  let sfact: StructuredFact | null = null;

  if (["preference", "my preference", "choice"].includes(targetLower)) {
    const [attr, prefTopic] = detectPreferenceDomain(correction.newValue, correction.oldValue);
    sfact = {
      entity: "user",
      attribute: attr !== "preference" ? attr : "preference",
      value: correction.newValue,
      memoryType: MemoryType.PREFERENCE,
      rawText: text,
    };
    topicKey = prefTopic;
    content = correction.newValue;
    mtype = MemoryType.PREFERENCE;
  } else if (!correction.oldValue) {
    const attr = correction.target.trim();
    const attrLower = attr.toLowerCase();
    if (/\b(target|deployment|database|db|provider|stack|hosting)\b/i.test(attrLower)) {
      mtype = MemoryType.DECISION;
    } else if (attrLower.includes("preference") || attrLower.includes("prefer")) {
      mtype = MemoryType.PREFERENCE;
    } else {
      mtype = MemoryType.FACT;
    }
    sfact = {
      entity: attr,
      attribute: attr,
      value: correction.newValue,
      memoryType: mtype,
      rawText: text,
    };
    topicKey = structuredFactToTopicKey(sfact);
    content = structuredFactToContent(sfact);
  } else {
    const [attr] = detectPreferenceDomain(correction.newValue, correction.oldValue);
    if (["database", "ui_library", "frontend_framework", "theme", "workflow"].includes(attr)) {
      mtype = MemoryType.DECISION;
    } else {
      mtype = MemoryType.FACT;
    }
    sfact = {
      entity: correction.target,
      attribute: attr,
      value: correction.newValue,
      memoryType: mtype,
      rawText: text,
    };
    topicKey = structuredFactToTopicKey(sfact);
    content = structuredFactToContent(sfact);
  }

  const authority = authorityForRole(message.role, message.content);
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
    sourceMessageIds: [message.messageKey],
    topicKey,
    authority,
    isCorrection: true,
    structuredFact: sfact,
    correction,
  };
  candidate.scores = scoreCandidate(candidate);
  return candidate;
}

function buildRevocationCandidate(
  message: NormalizedMessage,
  revocation: Revocation
): CandidateMemory | null {
  if (message.role !== "user") {
    return null;
  }
  const candidate: CandidateMemory = {
    content: `REVOKE: ${revocation.target}`,
    type: MemoryType.FACT,
    scores: {
      confidence: 0,
      importance: 0,
      stability: 0,
      freshness: 1,
      informationGain: 0,
    },
    sourceMessageIds: [message.messageKey],
    topicKey: "__revocation__",
    authority: "user",
    isCorrection: false,
    revocation,
  };
  candidate.scores = scoreCandidate(candidate);
  return candidate;
}

export function buildFactCandidate(
  message: NormalizedMessage,
  sfact: StructuredFact
): CandidateMemory | null {
  let authority = authorityForRole(message.role, message.content);
  let mtype = sfact.memoryType;
  if (message.role === "assistant" && (mtype === MemoryType.DECISION || mtype === MemoryType.CONSTRAINT)) {
    authority = "speculation";
  }

  const topicKey = structuredFactToTopicKey(sfact);

  const candidate: CandidateMemory = {
    content: structuredFactToContent(sfact),
    type: mtype,
    scores: {
      confidence: 0,
      importance: 0,
      stability: 0,
      freshness: 1,
      informationGain: 0,
    },
    sourceMessageIds: [message.messageKey],
    topicKey,
    authority,
    isCorrection: looksLikeCorrection(message.content) || Boolean(sfact.isUpdate),
    structuredFact: { ...sfact, route: "local" },
  };
  candidate.scores = scoreCandidate(candidate);
  return candidate;
}

const PRONOUN_SWITCH_RE = /^(it|this|that|the\s+project|the\s+app|we|our)$/i;

function attributeForValueSafe(value: string): string {
  // local classifier to avoid circular dependency; duplicates facts.attributeForValue
  const v = value.toLowerCase();
  if (/\b(turso|neon|postgres|postgresql|supabase|mysql|sqlite|libsql|mongodb|mariadb|dynamodb|database|db)\b/.test(v)) return "database";
  if (/\b(upstash|redis|memcached)\b/.test(v)) return "cache";
  if (/\b(cloudflare r2|r2|s3|gcs|object storage|storage)\b/.test(v)) return "storage";
  if (/\b(embedding|semantic|vector|retrieval)\b/.test(v)) return "semantic_retrieval";
  if (/\b(groq|openai|anthropic|gpt|llama|summariz)\b/.test(v)) return "summarization";
  if (/\b(hono|next|express|fastify|react|vue)\b/.test(v)) return "framework";
  if (/\b(cloudflare workers|deno|node|bun|lambda|vercel)\b/.test(v)) return "runtime";
  return "technology";
}

// "We switched <X> to <Y>" / "<X> switched to <Y>" -> update fact
const SWITCHED_TO_RE =
  /^(?:we\s+|i\s+)?(?:have\s+|have\s+we\s+)?switched\s+(?<target>[\w\s/-]+?)\s+to\s+(?<new>.+?)\s*[.!]?$/i;
const SWITCHED_BARE_RE =
  /^(?:we\s+|i\s+)?switched\s+to\s+(?<new>.+?)\s*[.!]?$/i;

function detectSwitchUpdate(text: string): StructuredFact | null {
  const cleanNew = (raw: string) =>
    raw
      .replace(/\s+(?:for|as)\s+(?:the|its|our|a|an)?\s*[a-z0-9 _/-]*$/i, "")
      .trim();

  let m = text.match(SWITCHED_TO_RE);
  if (m && m.groups) {
    const target = m.groups.target.trim();
    const newVal = cleanNew(m.groups.new.trim());
    const attr = attributeForValueSafe(newVal);
    const subject = PRONOUN_SWITCH_RE.test(target.toLowerCase()) ? "project" : target;
    return {
      entity: subject,
      attribute: attr,
      value: newVal,
      memoryType: MemoryType.DECISION,
      rawText: text,
      key: `project.${slugify(attr)}`,
      scope: "project",
      isUpdate: true,
    };
  }
  m = text.match(SWITCHED_BARE_RE);
  if (m && m.groups) {
    const newVal = cleanNew(m.groups.new.trim());
    const attr = attributeForValueSafe(newVal);
    return {
      entity: "project",
      attribute: attr,
      value: newVal,
      memoryType: MemoryType.DECISION,
      rawText: text,
      key: `project.${slugify(attr)}`,
      scope: "project",
      isUpdate: true,
    };
  }
  return null;
}

export interface ExtractionFallbackOptions {
  /** When provided, enables Groq fallback when local extraction yields nothing. */
  groqApiKey?: string;
  groqBaseUrl?: string;
  groqModel?: string;
  /** Skip the Groq fallback even when a key is configured. */
  forceLocal?: boolean;
}

export function extractFromMessageLocal(message: NormalizedMessage): CandidateMemory[] {
  if (message.role !== "user" && message.role !== "assistant") {
    return [];
  }
  if (isLowInfoMessage(message.content, message.role)) {
    debug("extract", "skipped message: low-info", {
      role: message.role,
      content: message.content,
    });
    return [];
  }
  if (isInterrogative(message.content)) {
    debug("extract", "skipped message: interrogative", {
      role: message.role,
      content: message.content,
    });
    return [];
  }
  if (looksSpeculative(message.content)) {
    debug("extract", "skipped message: speculative", {
      role: message.role,
      content: message.content,
    });
    return [];
  }

  const [stripped, hadPrefix] = stripCorrectionPrefix(message.content);
  if (isInterrogative(stripped)) {
    return [];
  }

  const revocation = parseRevocation(stripped);
  if (revocation !== null) {
    const candidate = buildRevocationCandidate(message, revocation);
    return candidate ? [candidate] : [];
  }

  const correction = parseCorrection(stripped);
  if (correction !== null) {
    const candidate = buildCorrectionCandidate(message, correction, stripped);
    if (candidate !== null) {
      return [candidate];
    }
  }

  // Split the message into atomic sentences and extract ALL facts.
  const sentences = splitSentences(stripped);
  const out: CandidateMemory[] = [];
  const seenKeys = new Set<string>();

  for (const sentence of sentences) {
    if (isLowInfoMessage(sentence, message.role) || isInterrogative(sentence)) {
      continue;
    }
    if (message.role === "assistant" && looksSpeculative(sentence)) {
      continue;
    }

    const update = detectSwitchUpdate(sentence);
    if (update) {
      const candidate = buildFactCandidate(message, update);
      if (candidate) out.push(candidate);
      continue;
    }

    const facts = extractStructuredFacts(sentence);
    for (const sfact of facts) {
      const key = sfact.key || structuredFactToTopicKey(sfact);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      const candidate = buildFactCandidate(message, sfact);
      if (candidate) out.push(candidate);
    }
  }

  // Fallback: non-structured pattern-based candidates (decision/constraint/...)
  if (out.length === 0) {
    const classified = classify(stripped);
    if (classified === null) {
      return [];
    }
    const [mtype, body, sfact] = classified;
    if (message.role === "assistant") {
      const [typed] = parsePrefix(message.content);
      if (typed === null) {
        return [];
      }
    }

    let authority = authorityForRole(message.role, message.content);
    if (message.role === "assistant" && (mtype === MemoryType.DECISION || mtype === MemoryType.CONSTRAINT)) {
      authority = "speculation";
    }

    const topicKey = sfact !== null ? structuredFactToTopicKey(sfact) : topicKeyFromContent(body, mtype);

    const candidate: CandidateMemory = {
      content: body,
      type: mtype,
      scores: {
        confidence: 0,
        importance: 0,
        stability: 0,
        freshness: 1,
        informationGain: 0,
      },
      sourceMessageIds: [message.messageKey],
      topicKey,
      authority,
      isCorrection: hadPrefix || looksLikeCorrection(message.content),
      structuredFact: sfact ? { ...sfact, route: "local" } : null,
    };
    candidate.scores = scoreCandidate(candidate);
    return [candidate];
  }

  return out;
}

export async function extractFromMessage(
  message: NormalizedMessage,
  fallback?: ExtractionFallbackOptions
): Promise<CandidateMemory[]> {
  const local = extractFromMessageLocal(message);
  if (local.length > 0 || !fallback || fallback.forceLocal || !fallback.groqApiKey) {
    return local;
  }

  // Local extraction found nothing. Before paying for a Groq call, make sure the
  // message isn't obviously non-memory (pure question / greeting / low-info).
  // If the gate flags it as a clear skip, don't call Groq.
  const gate = shouldConsiderMemory(message.content);
  const clearSkipReasons = new Set([
    "empty",
    "pure_question",
    "low_info",
    "greeting_or_acknowledgement",
    "general_knowledge_or_coding_request",
  ]);
  const isClearSkip =
    gate.reasons.length > 0 && gate.reasons.every((r) => clearSkipReasons.has(r));
  if (isClearSkip) {
    return [];
  }

  // Complex/ambiguous message that local extraction couldn't handle → force Groq.
  const groqBaseUrl =
    fallback.groqBaseUrl ||
    (typeof process !== "undefined" ? process.env.GROQ_BASE_URL : undefined) ||
    "https://api.groq.com/openai/v1";
  const hybrid = await extractStructuredFactsHybrid(message.content, {
    groqBaseUrl,
    groqApiKey: fallback.groqApiKey,
    groqModel: fallback.groqModel,
    forceGroq: true,
  });

  if (hybrid.facts.length === 0) {
    info("extract", "local extraction empty; Groq fallback also returned no facts", {
      role: message.role,
      content: message.content,
      route: hybrid.route,
      confidence: hybrid.confidence,
    });
    return [];
  }

  info("extract", "local extraction empty; fell back to Groq", {
    role: message.role,
    content: message.content,
    route: hybrid.route,
    confidence: hybrid.confidence,
    count: hybrid.facts.length,
    facts: hybrid.facts.map((f) => ({
      generatedBy: f.route ?? "groq",
      type: f.memoryType,
      subject: f.entity,
      predicate: f.attribute,
      value: f.value,
      topicKey: structuredFactToTopicKey(f),
    })),
  });

  const out: CandidateMemory[] = [];
  const seenKeys = new Set<string>();
  for (const sfact of hybrid.facts) {
    const key = sfact.key || structuredFactToTopicKey(sfact);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    const candidate = buildFactCandidate(message, sfact);
    if (candidate) out.push(candidate);
  }
  return out;
}

export async function extractCandidates(
  messages: NormalizedMessage[],
  fallback?: ExtractionFallbackOptions
): Promise<CandidateMemory[]> {
  const out: CandidateMemory[] = [];
  for (const msg of messages) {
    const before = out.length;
    out.push(...(await extractFromMessage(msg, fallback)));
    const generated = out.slice(before);
    if (generated.length > 0) {
      info("extract", "message extracted", {
        role: msg.role,
        content: msg.content,
        count: generated.length,
        facts: generated.map((c) => ({
          type: c.type,
          generatedBy: c.structuredFact?.route ?? "local",
          subject: c.structuredFact?.entity ?? c.subject ?? null,
          predicate: c.structuredFact?.attribute ?? c.predicate ?? null,
          value: c.structuredFact?.value ?? c.value ?? c.content,
          topicKey: c.topicKey ?? null,
        })),
      });
    } else {
      debug("extract", "message NOT extracted (no facts)", {
        role: msg.role,
        content: msg.content,
      });
    }
  }
  return out;
}
