<div align="center">
  <img src="./web/public/recall-github-cover-1mb.jpg" alt="Recall — Give your AI a memory" width="100%" />

  <h1>Recall</h1>

  <p>Give your AI a memory.</p>

  <p>An OpenAI-compatible memory gateway for persistent, context-aware AI applications and agents.</p>

  <p>
    <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white" alt="TypeScript" /></a>
    <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-339933?logo=node.js&logoColor=white" alt="Node.js" /></a>
    <a href="https://www.postgresql.org/"><img src="https://img.shields.io/badge/PostgreSQL-4169E1?logo=postgresql&logoColor=white" alt="PostgreSQL" /></a>
    <a href="https://redis.io/"><img src="https://img.shields.io/badge/Redis-DC382D?logo=redis&logoColor=white" alt="Redis" /></a>
    <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License" /></a>
    <img src="https://img.shields.io/badge/status-experimental-orange" alt="Status" />
  </p>
</div>

---

## What is Recall?

LLMs are powerful, but their memory is usually just a context window.

As conversations grow, applications have to keep sending more and more history. This increases token usage, context size, latency, and eventually causes old but important information to disappear from practical use.

Recall sits between your application and your AI provider and handles memory automatically.

```mermaid
flowchart TD
    A["🤖 Your App / AI Agent"] -->|OpenAI-compatible API| B

    subgraph B["⚡ Recall — Memory Gateway"]
        direction TB
        B1[Archive Conversations]
        B2[Extract Useful Facts]
        B3[Score Memories]
        B4[Resolve Conflicts]
        B5[Retrieve Relevant Memory]
        B6[Compile Bounded Context]
        B1 --> B2 --> B3 --> B4 --> B5 --> B6
    end

    B --> C[(PostgreSQL)]
    B --> D[(Redis)]
    B -->|Enriched request| E["☁️ Your AI Provider\nOpenAI · OpenRouter · Ollama · vLLM"]
    E -->|Normal response| A
```

Your application keeps using an OpenAI-compatible API. Recall handles the memory layer in the middle.

---

## Why Recall?

Without a memory layer, an application often has to choose between:

- Sending the entire conversation every time
- Manually maintaining summaries
- Building custom retrieval logic
- Creating provider-specific integrations
- Losing older information as context grows

Recall moves that responsibility into a dedicated gateway.

### The goal

Keep the model's context small without throwing away useful information.

Instead of treating every previous message as equally important, Recall can extract and maintain structured memories that can be retrieved when they become relevant.

---

## How It Works

Recall follows a memory lifecycle rather than simply dumping old messages into a vector database.

```mermaid
sequenceDiagram
    participant App as Your App / Agent
    participant GW as Recall Gateway
    participant DB as PostgreSQL
    participant Cache as Redis
    participant LLM as Upstream LLM

    App->>GW: POST /v1/chat/completions
    GW->>DB: Archive incoming messages
    GW->>GW: Detect memory-worthy facts
    GW->>GW: Score & resolve conflicts
    GW->>DB: Upsert memories
    GW->>Cache: Cache hot memories
    GW->>DB: Retrieve relevant memories
    GW->>GW: Compile compact context
    GW->>LLM: Forward enriched request
    LLM-->>GW: Stream / full response
    GW-->>App: Return response (unchanged format)
```

### 1. Archive

Incoming conversations are stored so the gateway can understand the history behind future interactions.

### 2. Detect

New messages are analyzed for potentially useful information such as:

- User preferences
- Project information
- Important facts
- Corrections
- Decisions
- Persistent instructions
- Relevant conversational state

### 3. Score

Memories can be evaluated using signals such as:

- Confidence
- Importance
- Stability
- Freshness
- Relevance

This helps distinguish persistent information from temporary conversation noise.

### 4. Resolve Conflicts

When newer information contradicts older information, Recall can supersede the outdated memory instead of blindly returning both.

```mermaid
flowchart LR
    A["🗂️ Old Memory\nproject.database = Neon\nconfidence: 0.90"] -->|Conflict detected| C{"Recall\nResolver"}
    B["💬 New Message\n'I switched to PostgreSQL'"] --> C
    C -->|Supersede| D["✅ Active Memory\nproject.database = PostgreSQL\nconfidence: 0.95"]
    C -->|Archive| E["🗃️ Archived\nproject.database = Neon\nsuperseded_at: now()"]
```

The old value is not simply forgotten — the memory system keeps the history while determining which information should currently be trusted.

### 5. Retrieve

When a new request arrives, Recall searches the available memory for information relevant to that request.

### 6. Compile

Relevant memories are converted into a compact context that can be provided to the upstream model.

### 7. Forward

The request is sent to the user's selected AI provider. The application still receives the model's normal response.

---

## Key Features

| Feature | Description |
|---|---|
| 🧠 **Persistent Memory** | Store useful information across conversations, beyond the context window |
| 🔍 **Context-Aware Retrieval** | Retrieve memories based on the current conversation, not the full history |
| 📊 **Memory Scoring** | Multi-signal scoring — confidence, importance, stability, freshness |
| ⚔️ **Conflict Resolution** | New information supersedes outdated facts automatically |
| 🔒 **Conversation Isolation** | Separate memory spaces per `X-Conversation-Id` |
| 🔌 **OpenAI-Compatible** | Drop-in gateway — only change the base URL |
| 🔑 **BYOK** | Bring your own API key, use any provider you already use |
| ⚡ **Streaming** | Supports streaming responses from compatible upstream providers |
| 🏠 **Self-Hosted** | Deploy with PostgreSQL, Redis, Docker, or plain Node.js |
| 🌐 **Provider Agnostic** | Works with any OpenAI-compatible provider |

---

## Quick Start

### Requirements

- Node.js or Bun
- PostgreSQL
- Redis
- An OpenAI-compatible upstream API

### 1. Clone

```bash
git clone https://github.com/Mahadi-rsio/recall.git
cd recall
```

### 2. Install dependencies

```bash
bun install
# or
npm install
```

### 3. Configure environment variables

Create a `.env` file:

```env
UPSTREAM_API_KEY=your_api_key
UPSTREAM_BASE_URL=https://api.openai.com/v1
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/recall
REDIS_URL=redis://localhost:6379
PORT=8787
```

### 4. Run database migrations

```bash
bun run db:migrate
```

### 5. Start Recall

```bash
bun run dev
```

The gateway will be available at `http://localhost:8787`

```bash
# Health check
curl http://localhost:8787/health
```

---

## Using Recall

Recall exposes an OpenAI-compatible API. For most clients, you only need to change the base URL.

### JavaScript / TypeScript

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "your-api-key",
  baseURL: "http://localhost:8787/v1",
});

const response = await client.chat.completions.create({
  model: "gpt-4o",
  messages: [
    { role: "user", content: "My name is Mahadi and I prefer TypeScript." },
  ],
  // Pass a stable ID to isolate this conversation's memory
  // @ts-ignore — custom header
  headers: { "X-Conversation-Id": "user-mahadi-session-1" },
});

console.log(response.choices[0].message.content);
```

### Python

```python
from openai import OpenAI

client = OpenAI(
    api_key="your-api-key",
    base_url="http://localhost:8787/v1",
    default_headers={"X-Conversation-Id": "user-mahadi-session-1"},
)

response = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "What stack do I use?"}],
)
print(response.choices[0].message.content)
```

### cURL

```bash
# First message — Recall stores the fact
curl http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "X-Conversation-Id: demo" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "My favorite color is green."}]
  }'

# Later — Recall retrieves the stored memory
curl http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "X-Conversation-Id: demo" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "What is my favorite color?"}]
  }'
```

---

## Supported Providers

Recall works with any OpenAI-compatible API:

| Provider | Notes |
|---|---|
| **OpenAI** | GPT-4o, GPT-4, GPT-3.5, etc. |
| **OpenRouter** | Access 100+ models via one key |
| **Ollama** | Local models (Llama, Mistral, Gemma…) |
| **LM Studio** | Local OpenAI-compatible server |
| **vLLM** | High-throughput inference server |
| **Any other** | As long as it's OpenAI-compatible |

Set `UPSTREAM_BASE_URL` to your provider's API endpoint.

---

## Architecture

```mermaid
graph TB
    subgraph Client["Client Layer"]
        APP["🤖 AI Application / Agent"]
    end

    subgraph Gateway["Recall Gateway (Node.js / Bun)"]
        ROUTER[Request Router]
        ARCH[Conversation Archiver]
        EXTRACT[Memory Extractor]
        SCORE[Memory Scorer]
        RESOLVE[Conflict Resolver]
        RETRIEVE[Memory Retriever]
        COMPILE[Context Compiler]
        FORWARD[Request Forwarder]

        ROUTER --> ARCH --> EXTRACT --> SCORE --> RESOLVE
        RESOLVE --> RETRIEVE --> COMPILE --> FORWARD
    end

    subgraph Storage["Storage Layer"]
        PG[(PostgreSQL\nMemories · Conversations)]
        RD[(Redis\nHot Cache · Sessions)]
    end

    subgraph Upstream["Upstream LLM"]
        LLM["☁️ OpenAI · OpenRouter\nOllama · vLLM · etc."]
    end

    APP -->|POST /v1/chat/completions| ROUTER
    ARCH <-->|Read / Write| PG
    SCORE <-->|Cache| RD
    RETRIEVE <-->|Query| PG
    FORWARD -->|Enriched request| LLM
    LLM -->|Response| APP
```

---

## Memory Model

Recall is designed around the idea that not every piece of conversation deserves permanent memory.

```mermaid
erDiagram
    CONVERSATION {
        uuid id PK
        string conversation_id
        timestamp created_at
    }
    MESSAGE {
        uuid id PK
        uuid conversation_id FK
        string role
        text content
        timestamp created_at
    }
    MEMORY {
        uuid id PK
        uuid conversation_id FK
        string subject
        string key
        text value
        float confidence
        float importance
        float stability
        float freshness
        boolean active
        uuid superseded_by FK
        timestamp created_at
        timestamp updated_at
    }

    CONVERSATION ||--o{ MESSAGE : contains
    CONVERSATION ||--o{ MEMORY : produces
    MEMORY ||--o| MEMORY : supersedes
```

A memory record tracks not just the value, but signals that help Recall decide how much to trust it:

```
subject:    project
key:        database
value:      PostgreSQL

confidence: 0.88   ← how certain is this fact?
importance: 0.65   ← how much does it matter?
stability:  0.55   ← how likely is it to change?
freshness:  1.00   ← how recently was it confirmed?
```

---

## Conversation IDs

Conversation isolation is important when multiple users or sessions share the same gateway.

```mermaid
flowchart LR
    U1["User A"] -->|X-Conversation-Id: user-a| GW[Recall Gateway]
    U2["User B"] -->|X-Conversation-Id: user-b| GW
    U3["Agent"] -->|X-Conversation-Id: agent-task-42| GW

    GW --> MA[("🔵 Memory Space A")]
    GW --> MB[("🟢 Memory Space B")]
    GW --> MC[("🟠 Memory Space C")]
```

Requests with the same conversation ID share the corresponding memory context. Different IDs create completely separate memory spaces. For production applications, always provide a stable, explicit conversation ID.

---

## Docker

```mermaid
graph LR
    subgraph compose["docker compose up -d --build"]
        GW["Recall Gateway\n:8787"]
        PG["PostgreSQL\n:5432"]
        PGB["PgBouncer\n:6432"]
        RD["Redis\n:6379"]
    end

    GW --> PGB --> PG
    GW --> RD
```

```bash
# Build and start all services
docker compose up -d --build

# Check status
docker compose ps

# View logs
docker compose logs -f recall
```

### GHCR

```bash
docker pull ghcr.io/Mahadi-rsio/recall-gateway:latest
```

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `UPSTREAM_API_KEY` | ✅ | — | API key for the upstream provider |
| `UPSTREAM_BASE_URL` | ✅ | — | Base URL of the OpenAI-compatible upstream |
| `DATABASE_URL` | ✅ | — | PostgreSQL connection string |
| `REDIS_URL` | ✅ | — | Redis connection string |
| `PORT` | ❌ | `8787` | Port the gateway listens on |

---

## Project Structure

```
recall/
├── src/
│   ├── memory/          # Memory extraction, scoring, retrieval
│   ├── routes/          # API route handlers
│   ├── services/        # Core business logic
│   └── index.ts         # Entry point
├── web/
│   ├── public/          # Landing page assets
│   └── index.html       # Web UI
├── migrations/          # Database migrations (Drizzle)
├── docker-compose.yml
├── Dockerfile
├── package.json
├── README.md
└── LICENSE
```

---

## Development

```bash
# Install dependencies
bun install

# Start dev server (with hot reload)
bun run dev

# Run migrations
bun run db:migrate

# Build for production
bun run build

# Run tests
bun test
```

---

## Roadmap

```mermaid
gantt
    title Recall Development Roadmap
    dateFormat  YYYY-MM
    section Retrieval
        Embedding-based retrieval       :active, 2025-07, 3M
        Improved semantic ranking       :2025-09, 2M
    section Memory Quality
        Memory consolidation            :2025-08, 2M
        Temporal reasoning              :2025-09, 3M
        Contradiction detection v2      :2025-10, 2M
    section Architecture
        Short vs long-term separation   :2025-08, 3M
        Agent-specific workflows        :2025-11, 2M
    section Observability
        Memory debugging UI             :2025-09, 2M
        Benchmark suites                :2025-10, 2M
    section Deployment
        More provider integrations      :2025-07, 4M
        More deployment options         :2025-11, 2M
```

---

## Contributing

Recall is open source and contributions are welcome.

You can contribute by:

- Fixing bugs
- Improving retrieval quality
- Improving memory extraction
- Adding tests
- Improving documentation
- Adding provider compatibility
- Improving deployment options
- Building developer tooling
- Proposing architectural improvements

### Workflow

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add or update tests
5. Open a pull request

Please keep changes focused and explain architectural decisions clearly.

---

## Security

Do not expose:

- API keys
- Database credentials
- Redis credentials
- Production secrets
- Private conversation data

Use environment variables or your deployment platform's secret management system.

If you discover a security vulnerability, please avoid publicly disclosing sensitive details before the issue has been investigated. Open a private security advisory on GitHub instead.

---

## License

Recall is licensed under the Apache License 2.0.

See [LICENSE](./LICENSE) for the full license text.

---

<div align="center">

**Recall**

Give your AI a memory.

Built for developers building AI applications that need more than a context window.

</div>
