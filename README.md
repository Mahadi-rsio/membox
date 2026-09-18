<p align="center">
  <img src="memory-core/public/1000013626-removebg-preview.png" alt="Remember" width="120" />
</p>

<h1 align="center">Remember</h1>

<p align="center">
  <strong>Persistent memory for AI agents.</strong><br />
  An OpenAI-compatible memory gateway that stores what matters, retrieves what matters, and keeps conversations lightweight.
</p>

<p align="center">
  <a href="https://github.com/Mahadi-rsio/Remember/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="License" /></a>
  <img src="https://img.shields.io/badge/runtime-Cloudflare%20Workers-orange" alt="Runtime" />
  <img src="https://img.shields.io/badge/lang-TypeScript-blue" alt="Language" />
  <img src="https://img.shields.io/badge/database-Neon%20(PostgreSQL)-green" alt="Database" />
  <img src="https://img.shields.io/badge/cache-Upstash%20Redis-red" alt="Cache" />
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#client-setup">Client setup</a> ·
  <a href="#project-structure">Structure</a> ·
  <a href="#contributing">Contributing</a> ·
  <a href="#license">License</a>
</p>

---

**Remember** is a transparent, OpenAI-compatible proxy that gives *any* client persistent memory.
Clients only change their `base_url` — no SDKs, no MCP, no custom tools required.

```
Client ──▶ Gateway ──▶ Main AI (answers)
              │
              └─▶ Neon (PostgreSQL): raw archive + compact memory + compiled context
```

> **MCP support:** an MCP layer is also available for session-aware clients that want
> explicit memory tools. See [`mcp.md`](./mcp.md) for architecture, tools, and the
> programmatic `processMessage` API.

## ✨ Features

- **Intelligent memory** — stores useful signals instead of blindly keeping entire conversations
- **Context-aware retrieval** — returns the memory relevant to the conversation happening now
- **Continuous learning** — learns from every interaction as the relationship evolves
- **Memory scoring** — evaluates relevance, confidence, importance, stability, and freshness
- **Conflict handling** — supersedes outdated information instead of accumulating contradictions
- **OpenAI-compatible** — drop-in for any client that speaks the OpenAI Chat Completions API
- **BYOK** — bring your own model provider; Remember operates as the memory layer
- **Streaming** — byte-identical SSE passthrough, memory extraction runs after the stream

## 🚀 Quick Start

### Local development

```bash
bun install
cp .dev.vars.example .dev.vars
# Edit .dev.vars — set UPSTREAM_API_KEY + DATABASE_URL

bun run db:migrate         # apply migrations to Neon
bun run dev                # → wrangler dev → http://localhost:8787
curl http://localhost:8787/health
```

No Neon database yet? Create one:

1. Sign up at [neon.tech](https://neon.tech) and create a project.
2. Copy the pooled connection string
   (`postgresql://user:password@...neon.tech/dbname?sslmode=require`).
3. Paste it as `DATABASE_URL` in `.dev.vars`.

Run the test suite:

```bash
bun test
```

### Deploy to Cloudflare

```bash
# Set secrets (never committed to source)
wrangler secret put UPSTREAM_API_KEY
wrangler secret put DATABASE_URL
wrangler secret put GATEWAY_API_KEY           # optional
wrangler secret put UPSTASH_REDIS_REST_URL    # optional
wrangler secret put UPSTASH_REDIS_REST_TOKEN  # optional
wrangler secret put MEMORY_AI_API_KEY         # optional

# Apply migrations to Neon
bun run db:migrate

# Deploy the Worker
bun run deploy
```

## 🧠 How it works

Every request is:

1. **Archived** to the raw history store.
2. **Diffed** against known history (delta detection).
3. **Distilled** into compact memory — durable facts as subject/predicate/value triples,
   transient "right now" state into short-term context with a TTL.
4. **Recompiled** into a fixed-budget context before reaching the main AI.

The main AI always generates the answer; responses are returned **unchanged**
(streaming and non-streaming). The gateway optimizes what goes *in*, never what comes *out*.

### Built-in chat UI

The Worker also serves a React + shadcn chat UI (built from [`web/`](./web/)) and a
`POST /api/chat` endpoint, all on the same port.

```bash
cd web && bun install && bun run build     # build the UI into web/dist
bun run dev                                # → http://localhost:8787 (UI + gateway)
```

Open **http://localhost:8787** to chat.

### Landing page

The open-source landing page lives in [`memory-core/`](./memory-core/), built with
**Astro + React** (static output, no SSR):

```bash
cd memory-core
bun install
bun run dev        # → http://localhost:4321
bun run build      # static site into dist/
```

## 🔌 Client setup

Set `base_url` to the gateway. Nothing else changes.

### OpenAI SDK (TypeScript)

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:8787/v1",
  apiKey: "sk-anything",              // gateway key if GATEWAY_API_KEY is set
  defaultHeaders: { "X-Conversation-Id": "my-thread-42" },
});

const r = await client.chat.completions.create({
  model: "gpt-4.1",
  messages: [{ role: "user", content: "My codename is Falcon-Nine." }],
});
```

Next session, a bare question — *"What's my codename?"* — already knows. Memory is keyed
per conversation via the `X-Conversation-Id` header. Without it, the gateway derives a
stable id from the first message of the thread.

### OpenAI SDK (Python)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8787/v1",
    api_key="sk-anything",
    default_headers={"X-Conversation-Id": "my-thread-42"},
)
r = client.chat.completions.create(
    model="gpt-4.1",
    messages=[{"role": "user", "content": "My codename is Falcon-Nine."}],
)
```

### curl

```bash
curl -X POST http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Conversation-Id: my-thread-42" \
  -d '{"model":"gpt-4.1","messages":[{"role":"user","content":"hi"}]}'
```

Full endpoint reference: [api.md](api.md).

## ⚙️ Environment

Local secrets live in `.dev.vars` (never committed). Non-secret vars go in `wrangler.jsonc` under `"vars"`.

| Variable | Default | Where | Purpose |
|----------|---------|-------|---------|
| `DATABASE_URL` | — | **secret** / `.dev.vars` | **Required for memory.** Neon/PostgreSQL connection string |
| `UPSTREAM_BASE_URL` | `https://api.openai.com/v1` | `wrangler.jsonc` | Main AI provider base URL |
| `UPSTREAM_API_KEY` | — | **secret** | **Required.** Key for the main AI |
| `MEMORY_AI_ENABLED` | `false` | `wrangler.jsonc` | Optional AI compressor for memory |
| `MEMORY_AI_BASE_URL` / `_MODEL` / `_API_KEY` | — | jsonc / secret | Memory AI config |
| `CONTEXT_BUDGET` | `8000` | `wrangler.jsonc` | Token budget for compiled context |
| `GATEWAY_API_KEY` | unset | secret | Optional bearer auth on the gateway |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | unset | secret | Optional Redis cache + rate limiting |

### Providers

The upstream is any OpenAI-compatible endpoint — OpenAI, OpenRouter, vLLM, Ollama
(`http://localhost:11434/v1`), LM Studio, etc. Point `UPSTREAM_BASE_URL` + `UPSTREAM_API_KEY`
at it. The Memory AI compressor (optional) is configured separately and never answers users.

## 📚 Documentation

| Doc | Purpose |
|-----|---------|
| [architecture.md](architecture.md) | Design invariants, phases, and module layout |
| [api.md](api.md) | HTTP surface reference |
| [PROMT.md](PROMT.md) | Product requirements & vision |
| [plan.md](plan.md) | Roadmap and phase plan |
| [todo.md](todo.md) | Progress tracking |
| [FIX.md](FIX.md) | Memory-correctness fixes and rationale |

## 🗂️ Project structure

```text
src/
├── index.ts              # Hono app entry
├── env.ts                # Env bindings interface
├── routes/               # v1.ts, health.ts, auth.ts, rate-limit.ts
├── providers/            # OpenAI-compatible adapter, Memory AI adapter
├── memory/               # delta, engine, extractor, facts, correction, revocation,
│                         # interrogative, low-info, scorer, contradiction, state, isolation
├── context/              # compiler, assembler, selector, tokens
├── storage/              # archive.ts (raw message writer)
├── retrieval/            # Retriever interface + PostgreSQL backend
├── cache/                # version-aware cache (Upstash Redis optional)
├── models/               # Zod schemas + TypeScript types
└── db/                   # Drizzle ORM + Neon client

drizzle/                  # Generated SQL migrations
scripts/migrate.ts        # Apply migrations to Neon
tests/                    # bun test suite
wrangler.jsonc            # Cloudflare Workers config
web/                      # React + shadcn chat UI (bundled into the Worker)
memory-core/              # Astro + React landing page (static site)
```

## 🛠️ Development

```bash
bun install
bun run dev          # wrangler dev
bun test             # test suite
bun run typecheck    # tsc --noEmit
bun run db:migrate   # apply migrations
bun run deploy       # deploy to Cloudflare Workers
```

Design docs: [architecture.md](architecture.md), [PROMT.md](PROMT.md), [api.md](api.md).

## 🔒 Security

- Upstream API keys are Wrangler secrets only; never logged, never archived, never echoed in errors.
- Optional `GATEWAY_API_KEY` enables bearer auth for clients.
- Conversation data is isolated per conversation/user key; raw history and compact memory live in Neon (PostgreSQL).
- Rate limiting via Upstash Ratelimit guards against abuse; memory/DB/retrieval failures degrade gracefully (the main AI is still called).

Found a vulnerability? Please read our [Security Policy](SECURITY.md).

## 🤝 Contributing

We welcome contributions of all kinds — bug reports, feature ideas, documentation, and code.

Please read our [Contributing Guide](CONTRIBUTING.md) and our
[Code of Conduct](CODE_OF_CONDUCT.md) before getting started.

1. **Fork** the repository.
2. **Create** a feature branch: `git checkout -b feat/my-feature`.
3. **Commit** your changes: `git commit -m "feat: add my feature"`.
4. **Push** to the branch: `git push origin feat/my-feature`.
5. Open a **pull request**.

## 📄 License

This project is licensed under the [Apache License 2.0](LICENSE).
