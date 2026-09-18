import type {
  ConsolidationConflict,
  ConsolidationResult,
  ConsolidatedMemory,
  MemoryAICandidate,
  MemoryAIOutput,
  ToolSummaryOutput,
} from "../models/memory.js";
import type { Env } from "../env.js";
import type { MemoryItem } from "../db/schema/memory.js";

const JSON_BLOCK_RE = /```(?:json)?\s*(?<json>\{[\s\S]*\}|\[[\s\S]*\])\s*```/;

/** System prompt from promt.md — Memory Extraction Engine contract. */
export const EXTRACTION_SYSTEM_PROMPT = `You are a Memory Extraction Engine for an AI memory system called Remember.

Your job is to analyze a conversation message and extract durable, meaningful memory candidates.

---

## YOUR ROLE

You are NOT the AI assistant answering the user.
You are a background memory processor.
You extract structured facts from what the user said.
You do NOT extract what the AI said (unless it's a decision the user confirmed).

---

## INPUT

You will receive:
- role: "user" | "assistant"
- content: the message text
- conversation_context: last 3-5 messages for reference (do NOT extract from these, only use for understanding)
- existing_memories: relevant currently stored memories (for conflict detection)

---

## EXTRACTION RULES

### STORE — Extract as long-term memory if:
- It is a durable fact about the user (name, location, age, profession)
- It is a preference that will remain true across conversations (language, tool, framework, workflow style)
- It is a decision that was made (architectural, technical, personal)
- It is a goal or intention with long-term relevance
- It is a constraint (budget, time, team size, technical limitation)
- It is an important event or milestone
- It describes the user's system, stack, or architecture

### CONTEXT — Extract as working/temporary memory if:
- It describes what the user is doing RIGHT NOW (current task, current file, current error)
- It is only relevant for this session or debugging context
- It will become irrelevant within hours or days

### DISCARD — Do NOT extract if:
- It is a greeting, filler, or social phrase (Hi, Thanks, Sounds good, I love this)
- It is a reaction to the AI's output (I love this answer, This is perfect)
- It is a question (questions contain no memory-worthy fact)
- It is already accurately captured in existing_memories with high confidence
- It is too vague to be useful (I use some tools, I sometimes prefer X)

---

## ANTI-OVER-STORAGE RULES

These patterns look like preferences but are NOT durable — DISCARD them:
- "I love this [AI output]" → reaction, not preference
- "I like how you [did X]" → feedback, not memory
- "That's a great [answer/idea/suggestion]" → noise

These ARE durable preferences — STORE them:
- "I love TypeScript" → preference.language = TypeScript
- "I prefer Neon over PlanetScale" → preference.database = Neon
- "I hate verbose code" → preference.coding_style = concise

---

## PREFERENCE NORMALIZATION

Normalize spelling variations:
- favourite → favorite
- colour → color
- organise → organize

Negative preferences use a separate namespace:
- "I hate red" → { predicate: "disliked_color", value: "red" }
- "I don't like verbose code" → { predicate: "disliked_coding_style", value: "verbose" }
Do NOT use the same predicate for positive and negative preferences.

---

## CONFLICT DETECTION

Compare each extracted candidate against existing_memories.
For each match on (subject + predicate):

- Same value → action: "REINFORCE" (increase confidence, do not duplicate)
- Different value → action: "SUPERSEDES" (new value replaces old)
- Opposite/contradicting → action: "CONTRADICTS" (flag for review, reduce old confidence)
- Subset/addition → action: "UPDATE" (merge into existing)
- Unrelated → action: "NEW"

---

## MEMORY TYPES

Use exactly one of:
FACT | PREFERENCE | DECISION | GOAL | CONSTRAINT | ARCHITECTURE | IMPORTANT_EVENT | ACTIVE_TASK | TEMPORARY_STATE

---

## SCOPE

Use exactly one of:
- USER → about the person (name, preferences, background)
- PROJECT → about a specific project (stack, decisions, architecture)
- SESSION → only relevant right now (temporary state, current task)

---

## OUTPUT FORMAT

Respond ONLY with a valid JSON array. No explanation, no markdown, no preamble.

If nothing is worth extracting, return an empty array: []

Each element:
{
  "action": "NEW" | "REINFORCE" | "SUPERSEDES" | "CONTRADICTS" | "UPDATE" | "DISCARD",
  "destination": "STORE" | "CONTEXT" | "DISCARD",
  "type": "FACT | PREFERENCE | DECISION | GOAL | CONSTRAINT | ARCHITECTURE | IMPORTANT_EVENT | ACTIVE_TASK | TEMPORARY_STATE",
  "scope": "USER" | "PROJECT" | "SESSION",
  "subject": "string",
  "predicate": "string — snake_case attribute name",
  "value": "string",
  "topicKey": "string — e.g. user.favorite_color",
  "confidence": 0.0-1.0,
  "importance": 0.0-1.0,
  "stability": "permanent" | "long-term" | "short-term" | "session",
  "ttl_hours": null | number,
  "supersedes_id": null | "existing memory id",
  "reinforces_id": null | "existing memory id",
  "informationGain": 0.0-1.0,
  "rawText": "the original phrase that triggered this extraction"
}

---

## SCORING GUIDE

confidence: 1.0 explicit, 0.8 implied, 0.5 inferred; never store below 0.4
importance: 1.0 core identity, 0.7 preference/goal, 0.4 minor, 0.1 trivial
informationGain: 1.0 new, 0.5 nuance, 0.0 already captured
stability: permanent | long-term | short-term | session
ttl_hours: null for STORE; 1-2 for CONTEXT
`;

export const CONSOLIDATION_SYSTEM_PROMPT = `You are a Memory Consolidation Engine for an AI memory system called Remember.

Your job is to take a cluster of related memory records and compress them into one or more consolidated, higher-quality memories.

---

## WHY CONSOLIDATION EXISTS

Over time, many small facts accumulate about the same topic.
Instead of retrieving 8 small facts about "user's tech stack", it is better to have 1 consolidated ARCHITECTURE memory.
This saves context tokens and improves retrieval quality.

---

## INPUT

You will receive:
- cluster_topic: the shared topic of these memories (e.g. "user.tech_stack")
- memories: array of existing memory records with their full metadata

---

## YOUR TASK

1. Read all memories in the cluster
2. Identify what can be merged without losing information
3. Produce a consolidated memory (or 2 at most if the topic is genuinely multi-faceted)
4. Mark which original memories are now superseded

---

## CONSOLIDATION RULES

- Do NOT lose any unique fact during consolidation
- If two memories contradict, keep the higher-confidence one and note the conflict
- Prefer structured values over prose (arrays, key-value over sentences)
- Set consolidated memory confidence = weighted average of source memories
- Set importance = highest importance among sources
- Set stability = most stable among sources
- Add all source memory IDs to sourceMemoryIds

---

## OUTPUT FORMAT

Respond ONLY with valid JSON. No explanation, no markdown.

{
  "consolidated": [
    {
      "type": "FACT | PREFERENCE | ARCHITECTURE | ...",
      "scope": "USER | PROJECT | SESSION",
      "subject": "string",
      "predicate": "string",
      "value": "string or structured object",
      "topicKey": "string",
      "confidence": 0.0-1.0,
      "importance": 0.0-1.0,
      "stability": "permanent | long-term | short-term | session",
      "sourceMemoryIds": ["id1", "id2", ...],
      "consolidationNote": "optional — what was merged or resolved"
    }
  ],
  "superseded_ids": ["id1", "id2", ...],
  "conflicts_detected": [
    {
      "memory_ids": ["idA", "idB"],
      "description": "what contradicts what",
      "resolution": "kept idA due to higher confidence"
    }
  ]
}
`;

export const TOOL_COMPRESSION_SYSTEM_PROMPT = `You are a Tool Output Compressor. Your role is to summarize tool/command execution output.
Keep crucial exit statuses, error codes, file paths, IDs, and core outputs.
Remove repetitive logs, progress bars, and boilerplate.

Output strictly valid JSON:
{
  "summary": "Concise 1-3 sentence summary of the execution outcome",
  "key_points": ["Specific result item, path, or error"],
  "status": "success | error | warning"
}
`;

const VALID_ACTIONS = new Set([
  "NEW",
  "REINFORCE",
  "SUPERSEDES",
  "CONTRADICTS",
  "UPDATE",
  "DISCARD",
]);
const VALID_DESTINATIONS = new Set(["STORE", "CONTEXT", "DISCARD"]);
const VALID_SCOPES = new Set(["USER", "PROJECT", "SESSION"]);
const VALID_STABILITIES = new Set(["permanent", "long-term", "short-term", "session"]);

export function extractJsonText(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(JSON_BLOCK_RE);
  if (match && match.groups && match.groups.json) {
    return match.groups.json.trim();
  }
  const firstArr = trimmed.indexOf("[");
  const lastArr = trimmed.lastIndexOf("]");
  if (firstArr !== -1 && lastArr !== -1 && lastArr > firstArr) {
    return trimmed.slice(firstArr, lastArr + 1);
  }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
}

function clamp01(n: number, fallback: number): number {
  if (typeof n !== "number" || Number.isNaN(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

function parseCandidate(raw: Record<string, unknown>): MemoryAICandidate | null {
  const action = String(raw.action || "NEW").toUpperCase();
  const destination = String(raw.destination || "STORE").toUpperCase();
  if (!VALID_ACTIONS.has(action) || !VALID_DESTINATIONS.has(destination)) {
    return null;
  }
  if (destination === "DISCARD" || action === "DISCARD") {
    return null;
  }

  const value = String(raw.value || "").trim();
  const predicate = String(raw.predicate || "").trim();
  if (!value || !predicate) return null;

  const confidence = clamp01(Number(raw.confidence), 0.8);
  if (confidence < 0.4) return null;

  let scope = String(raw.scope || "USER").toUpperCase();
  if (!VALID_SCOPES.has(scope)) scope = "USER";

  let stability = String(raw.stability || "long-term").toLowerCase();
  if (!VALID_STABILITIES.has(stability)) stability = "long-term";

  const ttlRaw = raw.ttl_hours;
  const ttl_hours =
    ttlRaw === null || ttlRaw === undefined || ttlRaw === ""
      ? null
      : Number(ttlRaw);

  return {
    action: action as MemoryAICandidate["action"],
    destination: destination as MemoryAICandidate["destination"],
    type: String(raw.type || "FACT").toUpperCase(),
    scope: scope as MemoryAICandidate["scope"],
    subject: String(raw.subject || "user"),
    predicate,
    value,
    topicKey: String(raw.topicKey || `${scope.toLowerCase()}.${predicate}`),
    confidence,
    importance: clamp01(Number(raw.importance), 0.7),
    stability: stability as MemoryAICandidate["stability"],
    ttl_hours: typeof ttl_hours === "number" && !Number.isNaN(ttl_hours) ? ttl_hours : null,
    supersedes_id: raw.supersedes_id != null ? String(raw.supersedes_id) : null,
    reinforces_id: raw.reinforces_id != null ? String(raw.reinforces_id) : null,
    informationGain: clamp01(Number(raw.informationGain), 0.8),
    rawText: String(raw.rawText || value),
  };
}

export class MemoryAIAdapter {
  private baseUrl: string;
  private apiKey?: string;
  private model: string;
  private retryOnce: boolean;

  constructor(options: {
    baseUrl: string;
    apiKey?: string;
    model: string;
    retryOnce?: boolean;
  }) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.retryOnce = options.retryOnce ?? true;
  }

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  private async postChat(messages: Array<{ role: string; content: string }>): Promise<string> {
    const url = `${this.baseUrl}/chat/completions`;
    const payload = {
      model: this.model,
      messages,
      temperature: 0.0,
    };
    const response = await fetch(url, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Memory AI HTTP error ${response.status}: ${await response.text()}`);
    }

    const data = (await response.json()) as any;
    const choices = data?.choices || [];
    if (choices.length === 0) {
      throw new Error("No completion choices returned by Memory AI");
    }
    return String(choices[0]?.message?.content || "");
  }

  async extractMemory(
    messagesText: string,
    currentMemorySummary?: string | null
  ): Promise<MemoryAIOutput | null> {
    let userPrompt = `Delta Messages to analyze:\n${messagesText}`;
    if (currentMemorySummary) {
      userPrompt = `existing_memories:\n${currentMemorySummary}\n\n${userPrompt}`;
    }

    const conversation: Array<{ role: string; content: string }> = [
      { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ];

    let rawResponse: string | null = null;
    try {
      rawResponse = await this.postChat(conversation);
      return this.parseAndValidateMemory(rawResponse);
    } catch (parseErr) {
      if (!this.retryOnce) {
        return null;
      }
      try {
        const retryConv = [...conversation];
        if (rawResponse) {
          retryConv.push({ role: "assistant", content: rawResponse });
        }
        retryConv.push({
          role: "user",
          content: `Previous output was not valid JSON matching the schema: ${parseErr}. Please output ONLY a valid JSON array.`,
        });
        const retryRaw = await this.postChat(retryConv);
        return this.parseAndValidateMemory(retryRaw);
      } catch {
        return null;
      }
    }
  }

  private parseAndValidateMemory(rawText: string): MemoryAIOutput {
    const clean = extractJsonText(rawText);
    const parsed = JSON.parse(clean);
    const rows: unknown[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.candidates)
        ? parsed.candidates
        : [];

    const candidates: MemoryAICandidate[] = [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const c = parseCandidate(row as Record<string, unknown>);
      if (c) candidates.push(c);
    }

    const obsolete_items = candidates
      .filter((c) => c.action === "SUPERSEDES" || c.action === "CONTRADICTS")
      .map((c) => c.supersedes_id || c.rawText)
      .filter(Boolean) as string[];

    return { candidates, obsolete_items };
  }

  private parseAndValidateConsolidation(rawText: string): ConsolidationResult {
    const clean = extractJsonText(rawText);
    const parsed = JSON.parse(clean);
    if (!parsed || typeof parsed !== "object") {
      throw new Error("Consolidation output is not an object");
    }

    const consolidatedRaw = Array.isArray(parsed.consolidated) ? parsed.consolidated : [];
    const consolidated: ConsolidatedMemory[] = [];
    for (const row of consolidatedRaw.slice(0, 2)) {
      if (!row || typeof row !== "object") continue;
      const predicate = String(row.predicate || "").trim();
      if (!predicate) continue;
      let scope = String(row.scope || "PROJECT").toUpperCase();
      if (!["USER", "PROJECT", "SESSION"].includes(scope)) scope = "PROJECT";
      let stability = String(row.stability || "long-term").toLowerCase();
      if (!["permanent", "long-term", "short-term", "session"].includes(stability)) {
        stability = "long-term";
      }
      const sourceMemoryIds = Array.isArray(row.sourceMemoryIds)
        ? row.sourceMemoryIds.map(String)
        : [];
      consolidated.push({
        type: String(row.type || "ARCHITECTURE").toUpperCase(),
        scope: scope as ConsolidatedMemory["scope"],
        subject: String(row.subject || "project"),
        predicate,
        value: row.value,
        topicKey: String(row.topicKey || `${scope.toLowerCase()}.${predicate}`),
        confidence: clamp01(Number(row.confidence), 0.8),
        importance: clamp01(Number(row.importance), 0.9),
        stability: stability as ConsolidatedMemory["stability"],
        sourceMemoryIds,
        consolidationNote: row.consolidationNote != null ? String(row.consolidationNote) : undefined,
      });
    }

    const superseded_ids = Array.isArray(parsed.superseded_ids)
      ? parsed.superseded_ids.map(String)
      : [];
    const conflicts_detected: ConsolidationConflict[] = Array.isArray(parsed.conflicts_detected)
      ? parsed.conflicts_detected
          .filter((c: unknown) => c && typeof c === "object")
          .map((c: any) => ({
            memory_ids: Array.isArray(c.memory_ids) ? c.memory_ids.map(String) : [],
            description: String(c.description || ""),
            resolution: String(c.resolution || ""),
          }))
      : [];

    return { consolidated, superseded_ids, conflicts_detected };
  }

  /**
   * Consolidate a related memory cluster into one (or two) higher-quality memories.
   * Returns null on failure so callers can fall back to deterministic consolidation.
   */
  async consolidateCluster(
    clusterTopic: string,
    memories: MemoryItem[]
  ): Promise<ConsolidationResult | null> {
    const payload = {
      cluster_topic: clusterTopic,
      memories: memories.map((m) => ({
        id: String(m.id),
        type: m.type,
        scope: m.scope,
        subject: m.subject,
        predicate: m.predicate,
        value: m.value || m.content,
        topicKey: m.topicKey,
        confidence: m.confidence,
        importance: m.importance,
        stability: m.stability,
        status: m.status,
      })),
    };

    const conversation: Array<{ role: string; content: string }> = [
      { role: "system", content: CONSOLIDATION_SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(payload) },
    ];

    let rawResponse: string | null = null;
    try {
      rawResponse = await this.postChat(conversation);
      return this.parseAndValidateConsolidation(rawResponse);
    } catch (parseErr) {
      if (!this.retryOnce) return null;
      try {
        const retryConv = [...conversation];
        if (rawResponse) {
          retryConv.push({ role: "assistant", content: rawResponse });
        }
        retryConv.push({
          role: "user",
          content: `Previous output was not valid JSON matching the consolidation schema: ${parseErr}. Please output ONLY the valid JSON object.`,
        });
        const retryRaw = await this.postChat(retryConv);
        return this.parseAndValidateConsolidation(retryRaw);
      } catch {
        return null;
      }
    }
  }

  async compressToolOutput(
    toolName: string,
    outputText: string,
    maxCharsThreshold = 300
  ): Promise<string> {
    if (outputText.length <= maxCharsThreshold) {
      return outputText;
    }

    const prompt = `Tool Name: ${toolName}\nRaw Output:\n${outputText}`;
    const conv = [
      { role: "system", content: TOOL_COMPRESSION_SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ];

    try {
      const raw = await this.postChat(conv);
      const clean = extractJsonText(raw);
      const val = JSON.parse(clean) as ToolSummaryOutput;
      return `[Tool: ${toolName} | ${val.status || "success"}] ${val.summary || ""}`;
    } catch {
      return `[Tool: ${toolName}] ${outputText.slice(0, maxCharsThreshold)}... (truncated)`;
    }
  }
}

export function createMemoryAIAdapter(env: Env): MemoryAIAdapter | null {
  const isEnabled = String(env.MEMORY_AI_ENABLED).toLowerCase() === "true";
  if (!isEnabled) {
    return null;
  }
  const baseUrl = env.MEMORY_AI_BASE_URL || "https://openrouter.ai/api/v1";
  const model = env.MEMORY_AI_MODEL || "cheap-model";
  return new MemoryAIAdapter({
    baseUrl,
    apiKey: env.MEMORY_AI_API_KEY,
    model,
    retryOnce: true,
  });
}
