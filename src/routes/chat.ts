import { Hono } from "hono";
import type { HonoContext } from "../env";
import { warn } from "../log";

/**
 * Chat router for the local web UI.
 *
 * The UI (built from web/ and served as Worker static assets) posts the latest
 * user message here. This endpoint forwards ONLY that single message to the
 * gateway's own /v1/chat/completions, which runs the memory pipeline and
 * compiles relevant context server-side. No conversation history is ever sent
 * to the upstream model.
 */
export const chatRouter = new Hono<HonoContext>();

type UIPart =
  | { type: "text"; text: string }
  | { type: string; [k: string]: unknown };

type UIMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  parts?: UIPart[];
  content?: string;
};

function encodeSSE(obj: unknown): Uint8Array {
  const bytes = new TextEncoder().encode(`data: ${JSON.stringify(obj)}\n\n`);
  return bytes;
}

const DONE = new TextEncoder().encode("data: [DONE]\n\n");

chatRouter.post("/api/chat", async (c) => {
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

  const text = (latest.parts ?? [])
    .filter((p): p is { type: "text"; text: string } => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("")
    .trim();

  if (!text) {
    return c.json({ error: "Empty message" }, 400);
  }

  const gatewayUrl = (c.env.GATEWAY_URL || "http://localhost:8787").replace(/\/$/, "");
  const apiKey = c.env.GATEWAY_API_KEY || "1234";
  const model = body.model || c.env.LIVE_MODEL || "deepseek-v4-flash-0731";

  // Forward ONLY the latest message to the gateway's chat completions route.
  const upstream = await fetch(`${gatewayUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      stream: true,
      messages: [{ role: "user", content: text }],
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    warn("chat", "upstream gateway returned an error", {
      status: upstream.status,
      detail: detail.slice(0, 512),
    });
    return c.json(
      { error: "Upstream error", status: upstream.status, detail },
      (upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502) as any,
    );
  }

  // Transform the OpenAI SSE stream into the useChat UI stream protocol.
  const transformStream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = transformStream.writable.getWriter();
  const textId = `text_${crypto.randomUUID()}`;

  (async () => {
    const reader = upstream.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sawContent = false;
    try {
      writer.write(encodeSSE({ type: "start" }));
      writer.write(encodeSSE({ type: "text-start", id: textId }));
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
          if (data === "[DONE]") continue;
          let json: any;
          try {
            json = JSON.parse(data);
          } catch {
            continue;
          }
          const delta = json?.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta.length > 0) {
            sawContent = true;
            writer.write(encodeSSE({ type: "text-delta", delta, id: textId }));
          }
        }
      }
      writer.write(encodeSSE({ type: "text-end", id: textId }));
      writer.write(
        encodeSSE({
          type: "finish",
          finishReason: sawContent ? "stop" : "error",
        }),
      );
      writer.write(DONE);
    } catch (err) {
      warn("chat", "chat stream error", { error: String(err) });
    } finally {
      try {
        await writer.close();
      } catch {
        /* already closed */
      }
      reader.releaseLock();
    }
  })();

  return new Response(transformStream.readable, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-vercel-ai-ui-message-stream": "v1",
      "x-accel-buffering": "no",
    },
  });
});
