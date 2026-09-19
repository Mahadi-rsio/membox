<div align="center"><img src="./web/public/recall-github-cover-1mb.jpg" alt="Recall — Give your AI a memory" width="100%" />Recall

Give your AI a memory.

An OpenAI-compatible memory gateway for persistent, context-aware AI applications and agents.

""TypeScript" (https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)" (https://www.typescriptlang.org/)
""Node.js" (https://img.shields.io/badge/Node.js-339933?logo=node.js&logoColor=white)" (https://nodejs.org/)
""PostgreSQL" (https://img.shields.io/badge/PostgreSQL-4169E1?logo=postgresql&logoColor=white)" (https://www.postgresql.org/)
""Redis" (https://img.shields.io/badge/Redis-DC382D?logo=redis&logoColor=white)" (https://redis.io/)
""License" (https://img.shields.io/badge/license-Apache--2.0-blue.svg)" (./LICENSE)

</div>---

What is Recall?

LLMs are powerful, but their memory is usually just a context window.

As conversations grow, applications have to keep sending more and more history. This increases token usage, context size, latency, and eventually causes old but important information to disappear from practical use.

Recall sits between your application and your AI provider and handles memory automatically.

┌──────────────────┐
│   Your App /     │
│    AI Agent      │
└────────┬─────────┘
         │
         │ OpenAI-compatible API
         ▼
┌──────────────────────────────┐
│          Recall              │
│      Memory Gateway          │
│                              │
│  • Archive conversations     │
│  • Extract useful facts      │
│  • Score memories            │
│  • Resolve conflicts         │
│  • Retrieve relevant memory  │
│  • Compile bounded context   │
└───────────┬──────────────────┘
            │
       ┌────┴─────┐
       ▼          ▼
 ┌──────────┐  ┌──────────┐
 │PostgreSQL│  │  Redis   │
 └──────────┘  └──────────┘
            │
            ▼
┌──────────────────────────────┐
│     Your Main AI Provider    │
│                              │
│ OpenAI / OpenRouter / vLLM   │
│ Ollama / LM Studio / etc.    │
└──────────────────────────────┘

Your application keeps using an OpenAI-compatible API. Recall handles the memory layer in the middle.

---

Why Recall?

Without a memory layer, an application often has to choose between:

- Sending the entire conversation every time
- Manually maintaining summaries
- Building custom retrieval logic
- Creating provider-specific integrations
- Losing older information as context grows

Recall moves that responsibility into a dedicated gateway.

The goal

Keep the model's context small without throwing away useful information.

Instead of treating every previous message as equally important, Recall can extract and maintain structured memories that can be retrieved when they become relevant.

---

How It Works

Recall follows a memory lifecycle rather than simply dumping old messages into a vector database.

1. Archive

Incoming conversations are stored so the gateway can understand the history behind future interactions.

2. Detect

New messages are analyzed for potentially useful information such as:

- User preferences
- Project information
- Important facts
- Corrections
- Decisions
- Persistent instructions
- Relevant conversational state

3. Score

Memories can be evaluated using signals such as:

- Confidence
- Importance
- Stability
- Freshness
- Relevance

This helps distinguish persistent information from temporary conversation noise.

4. Resolve Conflicts

When newer information contradicts older information, Recall can supersede the outdated memory instead of blindly returning both.

For example:

Old:
project.database = Neon

New:
I switched the project database to PostgreSQL.

Result:
project.database = PostgreSQL

The old value is not simply forgotten. The memory system keeps the history while determining which information should currently be trusted.

5. Retrieve

When a new request arrives, Recall searches the available memory for information relevant to that request.

6. Compile

Relevant memories are converted into a compact context that can be provided to the upstream model.

7. Forward

The request is sent to the user's selected AI provider.

The application still receives the model's normal response.

---

Key Features

Persistent Memory

Store useful information across conversations instead of relying entirely on the model's context window.

Context-Aware Retrieval

Retrieve memories based on the current conversation instead of blindly replaying the entire history.

Memory Scoring

Use multiple signals to determine how useful and reliable a memory is.

Conflict Resolution

New information can supersede outdated information.

Conversation Isolation

Use "X-Conversation-Id" to keep memories separated between conversations.

X-Conversation-Id: my-project-chat

OpenAI-Compatible

Use Recall as a drop-in gateway with OpenAI-compatible clients.

You generally only need to change the API base URL.

BYOK

Bring your own API key and use the AI provider you already use.

Recall does not require you to move your application to a proprietary model provider.

Streaming

Supports streaming responses for compatible upstream providers.

Self-Hosted

Run Recall yourself with PostgreSQL, Redis, Docker, or a normal Node.js environment.

Provider Agnostic

Recall is designed to work with OpenAI-compatible providers rather than locking the memory layer to one model vendor.

---

Quick Start

Requirements

- Node.js or Bun
- PostgreSQL
- Redis
- An OpenAI-compatible upstream API

1. Clone

git clone https://github.com/Mahadi-rsio/recall.git
cd recall

2. Install dependencies

Using Bun:

bun install

Or using npm:

npm install

3. Configure environment variables

Create a ".env" file:

UPSTREAM_API_KEY=your_api_key
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/recall
REDIS_URL=redis://localhost:6379

4. Run database migrations

bun run db:migrate

5. Start Recall

bun run dev

The gateway will be available at:

http://localhost:8787

Health check:

GET /health

---

Using Recall

Recall exposes an OpenAI-compatible API.

For example, with the OpenAI JavaScript SDK:

import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "your-api-key",
  baseURL: "http://localhost:8787/v1",
});

const response = await client.chat.completions.create({
  model: "your-model",
  messages: [
    {
      role: "user",
      content: "My name is Mahadi.",
    },
  ],
});

console.log(response.choices[0].message.content);

For a follow-up conversation, provide the same conversation ID:

X-Conversation-Id: my-conversation

This allows Recall to associate requests with the same memory space.

---

Curl

curl http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "X-Conversation-Id: demo" \
  -d '{
    "model": "your-model",
    "messages": [
      {
        "role": "user",
        "content": "My favorite color is green."
      }
    ]
  }'

Later:

curl http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "X-Conversation-Id: demo" \
  -d '{
    "model": "your-model",
    "messages": [
      {
        "role": "user",
        "content": "What is my favorite color?"
      }
    ]
  }'

Recall can retrieve the relevant memory and provide it to the upstream model.

---

Supported Providers

Recall works with OpenAI-compatible APIs, including setups based on:

- OpenAI
- OpenRouter
- vLLM
- Ollama
- LM Studio
- Other OpenAI-compatible servers

The important part is compatibility with the expected API interface, not the provider's brand.

---

Architecture

                    ┌─────────────────┐
                    │   AI Application │
                    │   / AI Agent    │
                    └────────┬────────┘
                             │
                             ▼
                  ┌─────────────────────┐
                  │       Recall        │
                  │   Memory Gateway    │
                  ├─────────────────────┤
                  │                     │
                  │  Conversation       │
                  │  Memory Extraction  │
                  │  Memory Scoring     │
                  │  Conflict Resolution│
                  │  Retrieval          │
                  │  Context Compiler   │
                  │                     │
                  └───────┬───────┬─────┘
                          │       │
                 ┌────────▼─┐   ┌─▼───────┐
                 │PostgreSQL│   │  Redis  │
                 └──────────┘   └─────────┘
                          │
                          ▼
                 ┌─────────────────┐
                 │ Upstream LLM    │
                 │                 │
                 │ OpenAI-compatible
                 │ Provider        │
                 └─────────────────┘

---

Memory Model

Recall is designed around the idea that not every piece of conversation deserves permanent memory.

A memory can contain information such as:

Subject: project
Key: database
Value: PostgreSQL

Confidence: 0.88
Importance: 0.65
Stability: 0.55
Freshness: 1.00

These signals can be used to determine which memories should be retained, retrieved, or superseded.

The exact memory representation can evolve as the project develops.

---

Conversation IDs

Conversation isolation is important when multiple conversations use the same gateway.

Use:

X-Conversation-Id: user-123-project-a

Requests with the same conversation ID share the corresponding memory context.

Different IDs create separate memory spaces.

If no conversation ID is supplied, the gateway may fall back to its own anonymous conversation handling.

For production applications, explicitly providing a stable conversation ID is recommended.

---

Docker

Recall can be deployed together with its supporting services.

Example architecture:

Docker Compose
│
├── Recall Gateway
├── PostgreSQL
├── PgBouncer
└── Redis

Build and start:

docker compose up -d --build

Check running services:

docker compose ps

---

GHCR

A container image is available through GitHub Container Registry:

ghcr.io/Mahadi-rsio/recall-gateway:latest

Example:

docker pull ghcr.io/Mahadi-rsio/recall-gateway:latest

---

Environment Variables

Variable| Description
"UPSTREAM_API_KEY"| API key for the upstream provider
"DATABASE_URL"| PostgreSQL connection string
"REDIS_URL"| Redis connection string
"PORT"| Gateway port
"UPSTREAM_BASE_URL"| OpenAI-compatible upstream API URL

Additional configuration may be available depending on the deployment environment.

---

Web Interface

Recall includes a built-in web interface for testing the gateway and interacting with the memory system.

The project also contains a landing page designed to explain the architecture and demonstrate the memory flow visually.

---

Project Structure

recall/
├── src/
│   ├── memory/
│   ├── routes/
│   ├── services/
│   └── ...
├── web/
│   ├── public/
│   └── ...
├── migrations/
├── docker-compose.yml
├── Dockerfile
├── package.json
├── README.md
└── LICENSE

---

Development

Install dependencies:

bun install

Start development server:

bun run dev

Run migrations:

bun run db:migrate

Build:

bun run build

Run tests:

bun test

---

Roadmap

Recall is still evolving.

Planned and experimental areas include:

- [ ] Improved semantic retrieval
- [ ] Better memory ranking
- [ ] Memory consolidation
- [ ] More robust temporal reasoning
- [ ] Improved contradiction detection
- [ ] Better short-term vs long-term memory separation
- [ ] Embedding-based retrieval
- [ ] Memory observability and debugging
- [ ] More provider integrations
- [ ] Larger benchmark suites
- [ ] Agent-specific memory workflows
- [ ] More deployment options

The roadmap is intentionally flexible. Memory systems are one of those wonderfully inconvenient areas where the obvious architecture usually breaks once real conversations arrive.

---

Contributing

Recall is open source and contributions are welcome.

You can contribute by:

- Fixing bugs
- Improving retrieval
- Improving memory extraction
- Adding tests
- Improving documentation
- Adding provider compatibility
- Improving deployment
- Building developer tooling
- Proposing architectural improvements

Development workflow

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add or update tests
5. Open a pull request

Please keep changes focused and explain architectural changes clearly.

---

Security

Do not expose:

- API keys
- Database credentials
- Redis credentials
- Production secrets
- Private conversation data

Use environment variables or your deployment platform's secret-management system.

If you discover a security vulnerability, please avoid publicly exposing sensitive details before the issue can be investigated.

---

License

Recall is licensed under the Apache License 2.0.

See "LICENSE" (./LICENSE) for the full license text.

---

<div align="center">Recall

Give your AI a memory.

Built for developers building AI applications that need more than a context window.

</div>ntext |
| `GATEWAY_API_KEY` | unset | Optional bearer auth on the gateway |
| `REDIS_URL` | unset | Optional self-hosted Redis for cache + rate limiting |
| `PORT` | `8787` | HTTP port the gateway listens on |
| `HOST` | `127.0.0.1` | Bind address for the gateway |

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
├── index.ts              # Express app entry (createApp factory + listener)
├── env.ts                # Env interface + getEnv() from process.env
├── http.ts               # Express Request/Response helpers
├── routes/               # v1.ts, chat.ts, memory.ts, health.ts, auth.ts, rate-limit.ts
├── providers/            # OpenAI-compatible adapter, Memory AI adapter
├── memory/               # delta, engine, extractor, facts, correction, revocation,
│                         # interrogative, low-info, scorer, contradiction, state, isolation
├── context/              # compiler, assembler, selector, tokens
├── storage/              # archive.ts (raw message writer)
├── retrieval/            # Retriever interface + PostgreSQL backend
├── cache/                # version-aware cache (self-hosted Redis optional)
├── models/               # Zod schemas + TypeScript types
└── db/                   # Drizzle ORM + pg client (self-hosted PostgreSQL)

drizzle/                  # Generated SQL migrations
scripts/migrate.ts        # Apply migrations to PostgreSQL (manual)
scripts/automigrate.ts    # Auto-apply migrations on server boot (src/index.ts)
tests/                    # bun test suite
chat/                     # React + shadcn chat UI (served at the gateway root)
web/                      # Astro + React landing page (static site)
```

## 🛠️ Development

```bash
bun install
bun run dev          # Node/Express via tsx
bun test             # test suite
bun run typecheck    # tsc --noEmit
bun run db:migrate   # apply migrations
```

Design docs: [architecture.md](architecture.md), [PROMT.md](PROMT.md), [api.md](api.md).

## 🔒 Security

- Upstream API keys are environment variables only; never logged, never archived, never echoed in errors.
- Optional `GATEWAY_API_KEY` enables bearer auth for clients.
- Conversation data is isolated per conversation/user key; raw history and compact memory live in PostgreSQL.
- Rate limiting via self-hosted Redis guards against abuse; memory/DB/retrieval failures degrade gracefully (the main AI is still called).

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
