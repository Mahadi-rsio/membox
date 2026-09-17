import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serveStatic } from "@hono/node-server/serve-static";
import { createUIMessageStream, createUIMessageStreamResponse, type UIMessage } from "ai";

/**
 * Environment for the local chat server. These mirror the gateway's env names
 * so a single `.env` can configure both.
 */
type ServerEnv = {
  GATEWAY_URL?: string;
  GATEWAY_API_KEY?: string;
  MODEL?: string;
};

function env(): ServerEnv {
  return {
    GATEWAY_URL: process.env.GATEWAY_URL || "http://localhost:8787",
    GATEWAY_API_KEY: process.env.GATEWAY_API_KEY || "1234",
    MODEL: process.env.MODEL || process.env.LIVE_MODEL || "deepseek-v4-flash-0731",
  };
}

const app = new Hono<{ Bindings: ServerEnv }>();

app.use("*", logger());
app.use("*", cors());

/**
 * The chat endpoint NEVER forwards conversation context to the model.
 * It extracts only the latest user message and sends that single message to
 * the Memory Gateway, which supplies memory/context server-side.
 */
app.post("/api/chat", async (c) => {
  const e = env();

  let body: { message?: UIMessage; model?: string } = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const latest = body.message;
  if (!latest || latest.role !== "user") {
    return c.json({ error: "No user message provided" }, 400);
  }

  const text = latest.parts
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("");

  if (!text.trim()) {
    return c.json({ error: "Empty message" }, 400);
  }

  const model = body.model || e.MODEL;

  // Only the latest message goes to the model. No history, no context.
  const upstream = await fetch(`${e.GATEWAY_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${e.GATEWAY_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      stream: true,
      messages: [{ role: "user", content: text }],
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const errText = await upstream.text().catch(() => "");
    return c.json({ error: "Upstream error", status: upstream.status, detail: errText }, 502);
  }

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      const reader = upstream.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const data = trimmed.slice(5).trim();
            if (data === "[DONE]") return;
            let json: any;
            try {
              json = JSON.parse(data);
            } catch {
              continue;
            }
            const delta = json?.choices?.[0]?.delta?.content;
            if (typeof delta === "string" && delta.length > 0) {
              writer.write({ type: "text-delta", delta, id: "" });
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    },
  });

  return createUIMessageStreamResponse({ stream });
});

app.get("/health", (c) => c.json({ ok: true }));

app.use("*", serveStatic({ root: "./dist" }));
app.use("*", serveStatic({ root: "./dist", path: "index.html" }));

const port = Number(process.env.PORT || 8000);
const host = process.env.HOST || "127.0.0.1";

if (process.env.NODE_ENV !== "test") {
  serve({ fetch: app.fetch, port, hostname: host }, (info) => {
    console.log(`\n  Remember chat server running at http://${host}:${port}`);
    console.log(`  Gateway: ${env().GATEWAY_URL}`);
    console.log(`  Model:   ${env().MODEL}\n`);
  });
}

export default app;
