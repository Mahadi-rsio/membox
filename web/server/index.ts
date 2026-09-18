import express from "express";
import cors from "cors";
import { Readable } from "node:stream";
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

const app = express();

app.use(cors());
app.use(express.json());

/**
 * The chat endpoint NEVER forwards conversation context to the model.
 * It extracts only the latest user message and sends that single message to
 * the Memory Gateway, which supplies memory/context server-side.
 */
app.post("/api/chat", async (req, res) => {
  const e = env();

  let body: { message?: UIMessage; model?: string } = req.body ?? {};
  if (typeof body !== "object" || body === null) {
    return res.status(400).json({ error: "Invalid JSON body" });
  }

  const latest = body.message;
  if (!latest || latest.role !== "user") {
    return res.status(400).json({ error: "No user message provided" });
  }

  const text = latest.parts
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("");

  if (!text.trim()) {
    return res.status(400).json({ error: "Empty message" });
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
    return res.status(502).json({ error: "Upstream error", status: upstream.status, detail: errText });
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

  const response = createUIMessageStreamResponse({ stream });
  const headers = Object.fromEntries(response.headers.entries());
  res.status(response.status).set(headers);
  if (response.body) {
    Readable.fromWeb(response.body as any).pipe(res);
  } else {
    res.end();
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.use(express.static("./dist"));
app.get("*", (req, res) => res.sendFile("index.html", { root: "./dist" }));

const port = Number(process.env.PORT || 8000);
const host = process.env.HOST || "127.0.0.1";

if (process.env.NODE_ENV !== "test") {
  app.listen(port, host, () => {
    console.log(`\n  Remember chat server running at http://${host}:${port}`);
    console.log(`  Gateway: ${env().GATEWAY_URL}`);
    console.log(`  Model:   ${env().MODEL}\n`);
  });
}

export default app;
