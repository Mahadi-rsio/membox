# Architecture — AI Memory Gateway

## Role

The Memory Gateway is a **stateful context transformation layer**, not a chatbot and not a conventional RAG system. It receives OpenAI-compatible requests, maintains persistent conversation memory, compiles a fixed-budget context, forwards to the **main** AI provider, and returns the upstream response **unchanged**.

## Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js |
| Framework | Express |
| Database | Neon (PostgreSQL) |
| ORM | Drizzle ORM |
| Cache | Upstash Redis (optional) |
| Language | TypeScript |

## High-Level Data Flow

```
OpenCode / Codex / AI Client
            │
            ▼
      Memory Gateway (Node.js / Express)
            │
     ┌──────┴─────────┐
     │                │
 Memory Engine    Context Compiler
     │                │
     ▼                ▼
Cheap AI Model   Optimized Context
 (optional)            │
     │                │
     └───────┬────────┘
             ▼
      MAIN AI PROVIDER
 OpenAI / Anthropic / Gemini /
 OpenRouter / OpenAI-compatible
             │
             ▼
     Original Response (unchanged)
             │
             ▼
           Client
```

### Central operation

```
PersistentContext[n] + NewMessages
        ↓
  Delta Detection
        ↓
  Memory Update
        ↓
PersistentContext[n+1]
        ↓
Fixed-Budget Context
        ↓
   MAIN AI MODEL
        ↓
 UNCHANGED RESPONSE
```

## Request Path (Hot Path)

Preferred critical path — keep it lightweight:

1. Receive OpenAI-compatible request
2. Authenticate / isolate conversation (`X-Conversation-Id` header or fingerprint)
3. Identify **delta** vs already-processed messages
4. Persist raw messages to Neon archive (fire-and-forget background task — non-blocking)
5. Load current versioned canonical memory
6. Deterministic memory processing
7. Call Memory AI **only when necessary**
8. Compile optimized context under token budget
9. Forward to main upstream API
10. Proxy response (stream or non-stream) **unchanged**
11. Record assistant output for memory (post-complete / async background task)

Expensive work (embeddings, deep consolidation, archival indexing, memory repair, long-term summarization) runs as background tasks and must not block token delivery.

## Component Map

```
src/
├── index.ts              # Express app entry (createApp factory + listener)
├── env.ts                # Env interface + getEnv() from process.env
├── http.ts               # Express Request/Response helpers
├── routes/
│   ├── v1.ts             # OpenAI-compatible HTTP routes
│   ├── chat.ts           # Built-in chat endpoint
│   ├── memory.ts         # Memory management endpoints
│   ├── health.ts         # Health check routes
│   ├── auth.ts           # Gateway API key auth middleware
│   └── rate-limit.ts     # Upstash Ratelimit middleware
├── providers/
│   ├── openai-compatible.ts  # Main upstream adapter
│   └── memory-ai.ts          # Optional Memory AI adapter
├── memory/
│   ├── delta.ts          # Delta detection (new vs processed)
│   ├── extractor.ts      # Candidate memory extraction
│   ├── engine.ts         # Memory pipeline orchestrator
│   ├── compressor.ts     # Tool-output compaction
│   ├── scorer.ts         # confidence, importance, freshness, etc.
│   ├── contradiction.ts  # Versioned supersede logic
│   ├── correction.ts     # Correction phrase detection
│   ├── revocation.ts     # Revocation phrase detection
│   ├── interrogative.ts  # Question classifier (no extraction)
│   ├── low-info.ts       # Low-info message filter
│   ├── facts.ts          # Declarative fact patterns
│   ├── consolidator.ts   # Cluster merge → consolidated memories
│   ├── state.ts          # Canonical memory CRUD + versioning
│   ├── ids.ts            # Message ID extraction + hash fallback
│   └── isolation.ts      # Conversation / user isolation keys
├── context/
│   ├── compiler.ts       # Fixed-budget context assembler
│   ├── assembler.ts      # Message list builder
│   ├── selector.ts       # Score-based item selection
│   └── tokens.ts         # Token counting utilities
├── storage/
│   └── archive.ts        # Raw message archive writer
├── retrieval/            # Retriever interface + PostgreSQL backend
├── cache/                # Version-aware cache (Upstash Redis optional)
├── models/               # Zod schemas + TypeScript types
└── db/                   # Drizzle ORM setup + Neon client

drizzle/                  # Generated SQL migrations
scripts/migrate.ts        # Apply migrations to Neon
tests/                    # Bun test suite
```

### API layer

- Exposes OpenAI-compatible surface so clients only change `base_url`.
- Does not require MCP, custom memory tools, or client SDK changes.
- Routes orchestrate memory + compile + provider; never rewrite assistant payloads.

### Provider layer

```typescript
class OpenAICompatibleProvider {
  async chat(body: Record<string, any>): Promise<ProxyResult>
  async responses(body: Record<string, any>): Promise<ProxyResult>
  async openStream(path: string, body: Record<string, any>): Promise<StreamResult>
  async models(): Promise<ProxyResult>
}
```

- **Main provider** (mandatory): generates the user-facing answer.
- **Memory AI provider** (optional): compresses/extracts structured memory only.
- Implementation: OpenAI-compatible HTTP adapter with configurable base URL.

### Memory engine

| Module | Responsibility |
|--------|----------------|
| `delta.ts` | Detect new vs processed messages (IDs or hashes) |
| `extractor.ts` | Candidate memory extraction (rules + optional AI) |
| `compressor.ts` | Summaries, tool-output compaction |
| `scorer.ts` | confidence, importance, stability, freshness, information_gain |
| `contradiction.ts` | Versioned supersede; protect confirmed decisions |
| `correction.ts` | Detect correction phrases; store `{type, target, old_value, new_value}` |
| `revocation.ts` | Detect revocation; set memory → REVOKED |
| `interrogative.ts` | Classify questions → skip extraction entirely |
| `low-info.ts` | Filter trivial messages (ok, thanks, yes…) |
| `state.ts` | Canonical memory CRUD + versioning |
| `isolation.ts` | Per-conversation / per-user key derivation |

Pipeline per delta:

```
New Messages
  → Interrogative Classifier (skip if question)
  → Low-Info Filter (skip if trivial)
  → Deterministic Rules (facts, corrections, revocations)
  → Candidate Extraction
  → Duplicate Detection
  → Contradiction Detection
  → Cheap AI Compression (if needed and enabled)
  → Canonical Memory Update
  → Versioned Context State
```

### Context compiler

Combines, under `CONTEXT_BUDGET`:

- System instructions
- Canonical memory (ACTIVE items only — no SUPERSEDED / REVOKED)
- Relevant recent context
- Important current tool results
- New user message

Selection score ≈ `value / token_cost`, where value includes relevance, confidence, importance, freshness, stability, and information gain. No naive truncation.

### Storage (Neon / PostgreSQL)

Three memory layers:

1. **Raw Archive** — original messages, tool I/O, metadata; never destroyed.
2. **Canonical Memory** — compact structured items (facts, decisions, constraints, preferences, goals, architecture, important_events, active_tasks).
3. **Recent Context** — short window of active conversation to avoid over-compression.

Every canonical update creates a new **context version** (`conversation_id`, `version`, `state`, `created_at`, `source_message_ids`). Never destructively mutate the only copy.

Schema managed by **Drizzle ORM**; migrations in `drizzle/`. Apply with:
```bash
bun run db:migrate   # applies to DATABASE_URL
```

### Retrieval

```typescript
interface Retriever {
  search(query: string, conversationId: string, limit?: number): Promise<MemoryItem[]>
}
```

- MVP backend: PostgreSQL LIKE search.
- Future: FTS, pgvector, Qdrant, Weaviate.
- Embeddings optional; use only when semantic retrieval is needed.

### Cache

Optional Upstash Redis; Neon sufficient for v1.

Layers: request, memory extraction, context compilation, retrieval.

Keys must include versions/hashes, e.g. `conversation_id + context_version + request_hash`. Never let an old cache entry override a newer context version.

## Memory Item Model

```typescript
interface MemoryItem {
  content: string;
  type: "fact" | "decision" | "constraint" | "preference" | "goal" | "architecture" | "important_event" | "active_task";
  confidence: number;    // 0–1
  importance: number;    // 0–1
  stability: number;     // 0–1
  freshness: number;     // 0–1
  information_gain: number; // 0–1
  source_message_ids: string[];
  created_at: string;
  updated_at: string;
  status: "ACTIVE" | "SUPERSEDED" | "REVOKED" | "EXPIRED";
  version: number;
}
```

Separate scores — do not collapse into one metric. Explicit user decisions outrank speculative model text. Corrections override prior memory. Low information gain skips duplicate writes.

## Memory AI Contract

When enabled, Memory AI returns a **strict JSON array** of extraction candidates (Zod-/schema-validated), per `promt.md`:

```json
[
  {
    "action": "NEW",
    "destination": "STORE",
    "type": "PREFERENCE",
    "scope": "USER",
    "subject": "user",
    "predicate": "favorite_color",
    "value": "red",
    "topicKey": "user.favorite_color",
    "confidence": 0.9,
    "importance": 0.8,
    "stability": "long-term",
    "ttl_hours": null,
    "supersedes_id": null,
    "reinforces_id": null,
    "informationGain": 0.9,
    "rawText": "I love red"
  }
]
```

On parse failure: retry once if configured; otherwise keep previous memory; never corrupt canonical state.

Memory AI must **not** generate the user's final answer.

When consolidating clusters, Memory AI (or the deterministic consolidator) returns:

```json
{
  "consolidated": [{ "type": "ARCHITECTURE", "predicate": "tech_stack", "value": {}, "topicKey": "user.tech_stack", "sourceMemoryIds": [] }],
  "superseded_ids": [],
  "conflicts_detected": []
}
```

## Failure Isolation

| Failure | Fallback |
|---------|----------|
| Memory AI down / bad JSON | Previous canonical memory + recent messages |
| DB / retrieval error | Best-effort recent messages → still call main AI |
| Upstash Redis miss | Skip cache; continue |
| Background task failure | Silently discarded; main response already sent |

Main upstream should remain usable whenever possible.

## Streaming

For `"stream": true`, proxy upstream SSE chunks directly via a streaming body. Do not buffer. Memory extraction runs after completion via a background task. Never delay tokens for background memory work.

## Security Boundaries

- API authentication via `GATEWAY_API_KEY` bearer token
- Per-user / conversation isolation (`X-Conversation-Id` or fingerprint)
- Request size limits (`MAX_REQUEST_BYTES`)
- Rate limiting via Upstash Ratelimit
- Secret redaction; no API-key logging; upstream keys never in Neon archive
- Configurable retention

## Configuration Surface

| Variable | Role |
|----------|------|
| `UPSTREAM_BASE_URL` / `UPSTREAM_API_KEY` | Main AI provider |
| `MEMORY_AI_ENABLED` / `MEMORY_AI_*` | Optional Memory AI compressor |
| `CONTEXT_BUDGET` | Token budget for compiled context |
| `GATEWAY_API_KEY` | Optional client→gateway bearer auth |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | Optional Redis cache + rate limiting |
| `DATABASE_URL` | Persistence (Neon / PostgreSQL) |

## What This Is Not

- Not a RAG-first embedding → top-k → LLM loop for every turn
- Not a replacement for the main reasoning model
- Not a client-visible memory chatbot API (transparency is the product)
- Not a Docker/server app as the primary target (plain Node.js/Express service; Docker is optional)

## Design Invariant

> The gateway optimizes what is sent **TO** the main model, but must not alter what comes **BACK FROM** the main model.
