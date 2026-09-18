# Implementation Plan — AI Memory Gateway

## Product Summary

Build a production-oriented **AI Memory Gateway / Context Compression Proxy** in **TypeScript** on **Node.js** (Express + Neon + Upstash Redis). It sits transparently between OpenAI-compatible clients (OpenCode, Codex, etc.) and the real upstream AI API. The gateway optimizes what is sent **to** the main model and must never alter what comes **back**.

## Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js |
| Framework | Express |
| Database | Neon (PostgreSQL) |
| Cache | Upstash Redis (optional) |
| ORM | Drizzle ORM |
| Language | TypeScript |
| Package manager | Bun |
| Tests | Bun test |

## Guiding Principles

1. **Transparent proxy** — client only changes `base_url`; no MCP, custom tools, or SDK changes.
2. **Main AI is mandatory** — gateway never replaces the reasoning model.
3. **Not conventional RAG** — primary loop is `Context[n] + delta → Memory Update → Context[n+1]` with a fixed-size active context.
4. **Raw archive is authoritative** — compact memory is derived and repairable.
5. **Failure isolation** — memory failures must not break main AI forwarding.
6. **Response transparency** — upstream response (including streams) is returned unchanged.

## Phased Delivery

### Phase 0 — Project skeleton ✅

- Express app entry (`src/index.ts`) + env from `process.env` (via `.env`).
- Config via `.env`: upstream provider, memory AI, budget, auth, Neon URL.
- Health endpoint and basic app bootstrap.
- `bun run dev` runs locally with Neon over HTTP (no Redis required).

**Exit criteria:** Express app starts; env loads; `bun run dev` works.

### Phase 1 — Transparent OpenAI-compatible proxy ✅

- Implement:
  - `POST /v1/chat/completions`
  - `POST /v1/responses`
  - `GET /v1/models`
- Provider abstraction (`OpenAICompatibleProvider`: `chat`, `responses`, `openStream`).
- First adapter: OpenAI-compatible (configurable `UPSTREAM_BASE_URL`).
- Pass-through auth headers / upstream API key from config.
- Streaming SSE proxy without full buffering.
- Request size limits and safe error mapping.

**Exit criteria:** point OpenCode/Codex at gateway; responses match direct upstream (no memory yet).

### Phase 2 — Persistence & delta detection ✅

- Drizzle ORM + D1 schema: conversations, raw messages, canonical memory, context versions, cache metadata.
- Raw archive for user/assistant/tool/system messages + metadata.
- Stable message IDs; fallback deterministic hashes (content + role + order).
- Delta detection: duplicates, retries, reorders, missing messages.
- Conversation / user isolation keys (from `X-Conversation-Id` header or deterministic fingerprint).

**Exit criteria:** every request archives raw messages; only new deltas are flagged for processing.

### Phase 3 — Memory engine (MVP, deterministic-first) ✅

- Three layers: Raw Archive, Canonical Memory, Recent Context.
- Memory item model: content, type, confidence, importance, stability, freshness, information_gain, status, version, source IDs.
- Pipeline: deterministic rules → candidate extraction → duplicate detection → contradiction handling → optional cheap AI → versioned state.
- Skip Memory AI for low-information messages (`ok`, `thanks`, `yes`, …).
- Contradiction: supersede old items; never silently overwrite confirmed user decisions with speculation.
- Information-gain gating before writes.

**Exit criteria:** memory updates from deltas without requiring Memory AI for trivial turns.

### Phase 4 — Optional Memory AI compressor ✅

- Memory AI adapter (same provider interface pattern; separate config).
- Structured JSON output + Zod schema validation.
- Retry-once on parse failure; otherwise leave memory unchanged.
- Tool-output compression into compact summaries; originals stay in raw archive.

**Exit criteria:** `MEMORY_AI_ENABLED=true` improves compression; disabled path still works.

### Phase 5 — Context compiler ✅

- Assemble: system instructions + canonical memory + recent context + important tool results + new user message.
- Token budget (`CONTEXT_BUDGET`); selection as value/token_cost (relevance, confidence, importance, freshness, stability, information_gain).
- No naive head/tail truncation.
- Versioned context snapshots (`conversation_id`, version, state, timestamps, source IDs).

**Exit criteria:** compiled context ≤ budget; main model still receives coherent prompts.

### Phase 6 — Retrieval & cache ✅

- D1 FTS (SQLite-compatible) over raw history and memory.
- `Retriever` interface ready for future backends.
- Version-aware caches: request, extraction, compilation, retrieval (Upstash Redis optional).
- Cache keys include conversation + context version + request hash; never serve stale over newer version.

**Exit criteria:** FTS search works; caches are version-safe; MVP runs without Redis.

### Phase 7 — Hardening, security, docs ✅

- API auth hooks, rate-limit hooks (Upstash Ratelimit), secret redaction, no key logging, retention config.
- Full test suite green; streaming + non-streaming response identity tests.
- README: install, env, OpenCode/Codex/OpenAI client setup, providers, budget, streaming, troubleshooting, security.
- `bun run start` boots the server for production (Node/Express).

**Exit criteria:** production-oriented MVP checklist from PROMT § Final Implementation Requirement is met.

### Phase 8 — Memory Correctness (Post-MVP, FIX.md) ✅

**Goal:** Fix the deterministic memory engine so it correctly handles natural-language facts, corrections, revocations, interrogative noise, stale memory, and contradictions.

**Targets:**
- Memory correctness ≥ 95%
- Correction accuracy ≥ 95%
- False-memory rate ≈ 0%
- Interrogative noise = 0%
- Cross-conversation leakage = 0%

**Tasks:**
1. Fix interrogative noise — classify questions before they can become memories.
2. Expand deterministic extraction — `I am building X`, `X uses Y`, `X's Z is …`, `The Y is X`.
3. Correction semantics — detect and store `{type, target, old_value, new_value}` records; supersede old facts.
4. Revocation / reset semantics — `ACTIVE | SUPERSEDED | REVOKED | EXPIRED` state model.
5. Conflict resolution — compiled context selects latest valid correction > latest ACTIVE fact.
6. False-memory protection — block acknowledgements, filler, model answers, unsupported assumptions.
7. Context compiler update — only ACTIVE / latest-correction entries in compiled context.
8. Comprehensive regression tests (varied wording; no benchmark-phrase hardcoding).

**Exit criteria:** memory correctness ≥ 95%, correction accuracy ≥ 95%, false-memory rate ≈ 0%, interrogative noise = 0%, all existing tests pass.

### Phase 9 — TypeScript Test Suite Parity (Current)

**Goal:** Validate the TypeScript implementation with a comprehensive test suite equivalent to the Python version's 158 tests. The codebase has all modules written but none are battle-tested.

**Tasks:**
- [ ] Proxy identity tests (stream + non-stream) with mocked upstream
- [ ] Delta detection unit tests (new, duplicate, retry, reorder)
- [ ] Memory engine unit tests (extract, merge, supersede, low-info skip)
- [ ] Correction / revocation integration tests
- [ ] Context compiler unit tests (budget, scoring, ACTIVE-only output)
- [ ] Interrogative noise tests
- [ ] Conversation isolation tests
- [ ] Fail-open behavior tests (D1 error, Memory AI error)
- [ ] Auth + rate limit tests
- [ ] End-to-end smoke against `bun run dev`

**Exit criteria:** all tests pass with `bun test`; coverage matches Python version's 158 tests.

### Phase 11 — Preference Promotion to Long-Term Memory (Current)

**Goal:** Correctly promote explicit, stable user preferences from temporary Redis context into durable `memory_items` records (subject/predicate/value triples) so they can be recalled later.

**Problem:** "I love red" is not durable. `PREFER_RE` only matches "prefer/would rather/preference"; no extractor handles affect verbs, so "I love red", "I really like TypeScript", "I hate MongoDB", "I love blue now" produce **zero candidates** and never reach `persistCandidates`. Explicit "My favorite color is red" / "My preferred database is Neon" are extracted by `extractTheYIsX` but mis-typed (`fact`/`decision`) and mis-scoped (`project`).

**Design invariants (requirement 4):**
- Preserve the pipeline: `raw message → deterministic extraction → analyzer/classifier → store/context/discard → persistent memory + Redis context`.
- Deterministic regex extraction only. **No uncontrolled LLM call** in the analyzer.
- No embeddings. No schema changes. Reuse the existing supersede/contradiction path.

**Tasks:**
- [x] `src/memory/facts.ts` — `detectPreferenceDomain`: add color domain → `favorite_color` / `preference:favorite_color` (exclude "rust" — clashes with the language keyword).
- [x] `src/memory/facts.ts` — new `extractFavoriteIs` (runs before `extractTheYIsX`): "my favorite|favourite|preferred \<attr\> is \<val\>" → `type=preference`, `entity=user`, `scope=user`, predicate `favorite_<attr>` / `preferred_<attr>` (colour→color normalized).
- [x] `src/memory/facts.ts` — new `extractAffectPreference`: "I (really)? love|like|enjoy|adore|hate|dislike \<X\>" → preference, user scope.
  - Anti-over-store guard (req 3): strip leading article; reject demonstrative (`this/that/these/those/it`), discourse nouns (`response, answer, reply, message, error, bug, result, output, suggestion, idea, solution, explanation`), and question words → "I love this response" yields no fact.
  - Strip trailing temporal adverbs ("now", "these days", "anymore") → "I love blue now" → value `blue`.
  - Negatives → predicate `disliked_<domain>` with its own topic key (no false supersede of positive preferences); `structuredFactToTopicKey` honors the `disliked_` attribute.
- [x] `src/memory/analyzer.ts` — `classifyCandidate` discards PREFERENCE candidates whose value matches the demonstrative/discourse-noun guard (defense in depth; also covers LLM-injected candidates).
- [x] `src/context/selector.ts` — `extractKeywords` normalizes `favourite→favorite`, `colour→color` so "What is my favourite colour?" matches predicate `favorite_color` via existing LIKE retrieval.
- [x] Tests — unit (`facts.test.ts`, `analyzer.test.ts`): 6 positive phrases → preference/user/correct predicate; 3 negative phrases → no fact; bucket `store`.
- [x] Tests — `tests/preference-persistence.integration.test.ts` (live Neon): "I love red" → `memory_items` row (`user`, `favorite_color`, `red`, active); "What is my favourite color?" → compiled context contains "red"; "I love this response" → no new rows; "I love blue now" → blue active + `supersedesId`, red `superseded`; recall returns blue.
- [x] `todo.md` — mark the corresponding correctness item(s) complete.
- [x] Memory AI extraction prompt (`src/providers/memory-ai.ts`) updated to `promt.md` JSON-array contract.
**Expected structured output (per req 2, following existing models):**
```json
{ "bucket": "store", "memoryType": "preference", "scope": "user",
  "subject": "user", "predicate": "favorite_color", "value": "red", "confidence": "high" }
```

**Unchanged:** `contradiction.ts`, `state.ts`, `engine.ts`, DB schema, routes — supersede fires automatically via the existing same-`topicKey` contradiction path; `content` stays value-only per the existing preference convention.

**Exit criteria:** `bun run typecheck` passes; `bun test` (unit + live-Neon integration with `.dev.vars` sourced) green; "I love red" persists and is recalled; "I love this response" is not stored; "I love blue now" supersedes red.

### Phase 12 — Memory Consolidation Engine ✅

**Goal:** Compress clusters of related atomic memories into one (or two) higher-quality consolidated records so the context compiler retrieves fewer, denser items.

**Tasks:**
- [x] Consolidation types + deterministic `consolidator.ts` (tech_stack clustering, conflict-by-confidence, structured values)
- [x] Memory AI `CONSOLIDATION_SYSTEM_PROMPT` + `consolidateCluster` with retry-once parse
- [x] Apply consolidated rows; supersede source ids; fail-open; engine wiring after writes
- [x] Unit + Neon integration tests

**Exit criteria:** 4+ stack preferences consolidate into `user.tech_stack` ARCHITECTURE; sources SUPERSEDED; compiled context still recalls language/database.

## Non-Goals

- Docker / server deployment (Node/Express).
- Python runtime.
- Requiring vector DB / Redis / embeddings.
- Replacing the main model with the memory model.
- Conventional RAG as the primary architecture.
- Rewriting or enriching client-visible assistant responses.

## Risk Register

| Risk | Mitigation |
|------|------------|
| D1 FTS5 support gaps | Test FTS in Workers Vitest; fallback to LIKE query |
| Memory AI latency on hot path | Deterministic-first; skip low info; async post-stream via `waitUntil` |
| Corrupt memory from bad JSON | Zod validation; retry once; keep prior state |
| Context quality regressions | Versioned state; repair from raw archive; budget-aware scoring |
| Client incompatibilities | Strict OpenAI-compatible shapes; response byte/stream identity tests |

## Success Metrics

- Client base URL swap works without code changes.
- Upstream response identity (non-stream + stream).
- Active context stays within configured token budget.
- Memory failures fall back without failing the main request.
- `bun run dev` alone is enough to run locally.
- `bun run start` alone is enough to go to production.
