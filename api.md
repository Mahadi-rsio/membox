# API — AI Memory Gateway

OpenAI-compatible HTTP API. Clients point `base_url` at the gateway; no MCP, custom tools, or SDK changes required.

## Base URL

Production:

```
https://<your-node-host>/v1
```

Local dev (`bun run dev`):

```
http://localhost:8787/v1
```

Client → Gateway → Upstream:

```
Client
  ↓
http://localhost:8787/v1   # or https://<your-node-host>/v1
  ↓
https://api.openai.com/v1   # or OpenRouter / local / other compatible
```

## Authentication

Gateway authentication (client → gateway) is configurable via `GATEWAY_API_KEY`. Upstream credentials are configured on the gateway and must never appear in conversation logs.

Typical client header (when gateway auth enabled):

```http
Authorization: Bearer <GATEWAY_API_KEY>
```

Upstream uses server-side config (environment variables, set in `.env`):

```bash
export UPSTREAM_API_KEY=...
```

Other server-side vars (in `.env`):

```dotenv
UPSTREAM_BASE_URL=https://api.openai.com/v1
```

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/v1/chat/completions` | Chat Completions (primary) |
| `POST` | `/v1/responses` | Responses API |
| `GET` | `/v1/models` | List models (proxied / filtered) |
| `GET` | `/health` | Liveness (gateway-local) |
| `GET` | `/v1/health` | Liveness alias |

### POST `/v1/chat/completions`

Accepts standard OpenAI Chat Completions request bodies.

Gateway behavior:

1. Archive raw messages via `waitUntil` (non-blocking)
2. Compile fixed-budget context from persistent memory
3. Forward optimized request to main upstream
4. Return upstream response **unchanged**

Streaming:

```json
{
  "model": "gpt-4.1",
  "stream": true,
  "messages": [
    {"role": "user", "content": "Continue the Neon migration plan."}
  ]
}
```

When `stream: true`, the gateway proxies upstream SSE chunks to the client without buffering the full stream. Memory extraction runs after completion via `waitUntil`.

Non-streaming: JSON body is returned exactly as received from upstream.

### POST `/v1/responses`

OpenAI-compatible Responses API passthrough with the same memory → compile → upstream → unchanged response pipeline.

### GET `/v1/models`

Proxies models from the configured upstream so clients can discover models through the gateway base URL.

### GET `/health`

Gateway-local health check. Used by monitoring / orchestration.

## Conversation Identity

The gateway keys persistent state by conversation identifier derived from:

- Explicit `X-Conversation-Id` header (recommended)
- Deterministic fingerprint from message history (fallback)

Clients should send a stable `X-Conversation-Id` across turns for correct delta detection and memory continuity.

```http
X-Conversation-Id: my-thread-42
```

## What the Gateway Changes vs Does Not Change

| Direction | Behavior |
|-----------|----------|
| **Request → Upstream** | May replace `messages` with a compiled fixed-budget context derived from persistent memory + recent context + new user message |
| **Response → Client** | Must be identical to upstream (stream and non-stream). No rewriting of assistant text, tool calls, arguments, finish reasons, usage, response IDs, or metadata |

## Memory AI (Not a Client API)

Memory compression uses an optional internal adapter. It is **not** exposed as a separate public endpoint.

```bash
export MEMORY_AI_API_KEY=...
```

```jsonc
"vars": {
  "MEMORY_AI_ENABLED": "false",
  "MEMORY_AI_PROVIDER": "openrouter",
  "MEMORY_AI_BASE_URL": "https://openrouter.ai/api/v1",
  "MEMORY_AI_MODEL": "cheap-model"
}
```

Memory AI returns validated structured JSON for internal state updates only.

## Context Budget

```jsonc
"vars": {
  "CONTEXT_BUDGET": "8000"
}
```

Or override per-request via header:

```http
X-Context-Budget: 4000
```

Compiled context sent upstream should be ≤ this token budget. Selection is score-based (`value / token_cost`), not naive truncation.

## Error Behavior

- Upstream errors: proxied to the client with safe handling; upstream status/body preserved where appropriate.
- Memory / DB / retrieval / Memory AI failures: **fallback** to previous canonical memory + recent messages; main AI still called.
- Malformed Memory AI output: retry once if configured; otherwise leave memory unchanged.

Memory failures must not break the main completion path.

## Rate Limiting

Optional Upstash Ratelimit enforced at the gateway edge. Configure:

```bash
export UPSTASH_REDIS_REST_URL=...
export UPSTASH_REDIS_REST_TOKEN=...
```

## Client Configuration Examples

### OpenAI SDK (TypeScript)

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:8787/v1",
  apiKey: "sk-anything",   // or GATEWAY_API_KEY value
  defaultHeaders: {
    "X-Conversation-Id": "my-thread-42",
  },
});

const r = await client.chat.completions.create({
  model: "gpt-4.1",
  messages: [{ role: "user", content: "My codename is Falcon-Nine." }],
});
```

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

### OpenCode / Codex / any OpenAI-compatible tool

```text
base_url = http://localhost:8787/v1
api_key  = <GATEWAY_API_KEY or anything>
model    = <upstream model name>
```

## Invariant

The public API looks like OpenAI. Internally the gateway rewrites **outgoing context** only. **Incoming model responses are never altered.**
