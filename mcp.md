# MCP Integration — Remember Memory Gateway

The MCP layer gives an AI client (host) durable **session** and **memory** capabilities
while keeping the Memory Gateway as the **single source of truth** for persistent memory.

## Architecture Invariant

- **MCP** owns: session lifecycle, current-conversation tracking, current-context
  semantic search, MCP tools, and Gateway communication.
- **Gateway** owns: persistent memory (extraction, retrieval, learning, scoring,
  conflict/supersede, context compilation) and storage (Neon + Redis).
- The MCP layer **never** touches the Gateway database directly. Every persistent
  memory operation flows over HTTP to the Gateway endpoints.
- **Every message** handled by the MCP must flow through
  `POST /v1/memory/process` — MCP must never become a second memory database.

## Data Flow

```
AI Client (MCP host)
   │  tool calls / processMessage
   ▼
MCP Layer (Cloudflare Worker)
   ├── SessionStore (in-memory, stable across messages)
   ├── ContextTracker (current conversation + lexical semantic search)
   └── GatewayClient (HTTP) ──► Gateway /v1/memory/* ──► Memory Core (Neon/Redis)
```

For every user message the MCP:

1. Ensures a stable session exists (create once, reuse across messages).
2. Records the message into the current conversation context.
3. Runs a current-context semantic search to surface only the relevant prior
   messages (never the full history).
4. Calls `POST /v1/memory/process` on the Gateway with the message + relevant
   context.
5. Returns the compiled context for the AI provider.

## Session Model

Memory is scoped by a `userId` derived from the API key. To support sessions
without rewriting the engine, the Gateway derives an isolated, stable memory
scope per `(auth user, session)` pair:

```
sess:{baseUserId[0:16]}:{sha256(baseUserId + ":" + sessionId)[0:40]}
```

- Different sessions → different memory scope (isolation)
- Same session → same scope (stability across messages)
- No session → plain API-key user id (existing behavior preserved)

Session ids must match `/^[A-Za-z0-9_-]{1,128}$/`. Malformed ids are rejected.

### Legacy inline marker

For compatibility, a message may carry a leading marker that is parsed and
**never forwarded to the AI**:

```
___$$(sess_123)$$___What is my name?
```

→ session `sess_123`, clean text `What is my name?`

The MCP → Gateway path prefers structured JSON (`session_id` field) over the
marker.

## MCP Tools

| Tool | Purpose |
|------|---------|
| `memory_session_create` | Create/reuse a stable session |
| `memory_search` | Search persistent memory (via Gateway) |
| `memory_save` | Explicitly save a fact (via Gateway) |
| `memory_update` | Update a fact value (supersedes old value) |
| `memory_forget` | Revoke memory by id/topic/attribute/content |
| `memory_context_search` | Search current conversation context (MCP-local) |

## Gateway Endpoints

All are `POST` and require `Authorization: Bearer <GATEWAY_API_KEY>`.

| Endpoint | Body |
|----------|------|
| `/v1/memory/process` | `{ session_id, message, context? }` |
| `/v1/memory/search` | `{ session_id, query, limit? }` |
| `/v1/memory/save` | `{ session_id, value, subject?, attribute?, type?, scope? }` |
| `/v1/memory/update` | `{ session_id, value, id?\|topic_key?, ... }` |
| `/v1/memory/forget` | `{ session_id, id?\|topic_key?\|attribute?\|content? }` |

## Programmatic API

The MCP layer exposes a high-level client for hosts that want automatic
every-message processing:

```ts
import { RememberClient } from "./src/mcp";

const remember = new RememberClient();

const { session_id } = remember.createSession("sess_123"); // or reuse existing

const out = await remember.processMessage({
  sessionId: session_id,
  message: "What is my name?",
});

const aiMessages = [
  ...out.relevantContext,          // relevant prior messages
  ...out.memoryContext,            // persistent memories
  { role: "user", content: message },
];

remember.recordAssistantMessage({ sessionId: session_id, content: assistantReply });
```

## Security & Reliability

- Session ids validated against `/^[A-Za-z0-9_-]{1,128}$/`.
- Auth via `Authorization: Bearer` on all `/v1/memory/*` and MCP routes.
- Request timeout (15s default) and 64 KB max message size enforced client-side.
- Writes (save/update/forget/process) are **not** retried (not idempotent); only
  the idempotent search is retried once on transient failure.
- Fail-open: memory pipeline errors are logged and never break the message flow.
- No raw conversations in logs — only lengths and counts.

## Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `GATEWAY_URL` | `http://localhost:8787` | Base URL the MCP uses to reach the Gateway |
| `GATEWAY_API_KEY` | — | Bearer token for MCP → Gateway auth |

## Mount Points

The Hono app mounts:

- `/v1/memory/*` — Gateway memory endpoints
- `/mcp` — MCP Streamable HTTP endpoint (`WebStandardStreamableHTTPServerTransport`)
