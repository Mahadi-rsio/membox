import { describe, expect, it, afterEach } from "bun:test";
import request from "supertest";
import { createApp } from "../src/index";

const UPSTREAM_BODY = {
  id: "chatcmpl-123",
  object: "chat.completion",
  created: 1712345678,
  model: "gpt-test",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "Hello from upstream" },
      finish_reason: "stop",
    },
  ],
};

const SSE_CHUNKS = [
  'data: {"id":"chatcmpl-s1","choices":[{"index":0,"delta":{"content":"Hel"}}]}\n\n',
  'data: {"id":"chatcmpl-s1","choices":[{"index":0,"delta":{"content":"lo"}}]}\n\n',
  "data: [DONE]\n\n",
];

function sseResponse(): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of SSE_CHUNKS) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function chatRequestEnv() {
  return {
    UPSTREAM_BASE_URL: "https://upstream.test/v1",
    CONTEXT_BUDGET: "8000",
  };
}

describe("Transparent Proxy Integration (fail-open, response identity)", () => {
  it("forwards non-streaming chat completions with byte-identical upstream response", async () => {
    const upstreamBody = { ...UPSTREAM_BODY };
    globalThis.fetch = (async (url: any, init: any) => {
      expect(String(url)).toBe("https://upstream.test/v1/chat/completions");
      const sent = JSON.parse(init.body);
      expect(sent.messages[0].role).toBe("user");
      return new Response(JSON.stringify(upstreamBody), {
        status: 200,
        headers: { "Content-Type": "application/json", Authorization: "Bearer 1234" },
      });
    }) as any;

    const res = await request(createApp(chatRequestEnv()))
      .post("/v1/chat/completions")
      .set("Content-Type", "application/json")
      .set("Authorization", "Bearer 1234")
      .send({
        model: "gpt-test",
        messages: [{ role: "user", content: "I prefer PostgreSQL" }],
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body).toEqual(UPSTREAM_BODY);
  });

  it("streams SSE responses unchanged through the gateway", async () => {
    globalThis.fetch = (async () => sseResponse()) as any;

    const res = await request(createApp(chatRequestEnv()))
      .post("/v1/chat/completions")
      .set("Content-Type", "application/json")
      .set("Authorization", "Bearer 1234")
      .send({
        model: "gpt-test",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.text).toBe(SSE_CHUNKS.join(""));
  });

  it("returns 400 with OpenAI-style error for malformed JSON", async () => {
    const res = await request(createApp(chatRequestEnv()))
      .post("/v1/chat/completions")
      .set("Content-Type", "application/json")
      .set("Authorization", "Bearer 1234")
      .send("{not valid json");

    expect(res.status).toBe(400);
    expect(res.body.error.type).toBe("invalid_request_error");
    expect(res.body.error.code).toBe("invalid_json");
  });

  it("maps upstream failures to 502 without leaking internals", async () => {
    globalThis.fetch = (async () => {
      throw new Error("connection refused with secret-details");
    }) as any;

    const res = await request(createApp(chatRequestEnv()))
      .post("/v1/chat/completions")
      .set("Content-Type", "application/json")
      .set("Authorization", "Bearer 1234")
      .send({
        model: "gpt-test",
        messages: [{ role: "user", content: "hi" }],
      });

    expect(res.status).toBe(502);
    expect(res.body.error.type).toBe("upstream_error");
    expect(JSON.stringify(res.body)).not.toContain("secret-details");
  });

  it("fails open: missing DB config does not block upstream forwarding", async () => {
    let upstreamCalled = false;
    globalThis.fetch = (async () => {
      upstreamCalled = true;
      return new Response(JSON.stringify(UPSTREAM_BODY), {
        status: 200,
        headers: { "Content-Type": "application/json", Authorization: "Bearer 1234" },
      });
    }) as any;

    const res = await request(createApp({ UPSTREAM_BASE_URL: "https://upstream.test/v1" }))
      .post("/v1/chat/completions")
      .set("Content-Type", "application/json")
      .set("Authorization", "Bearer 1234")
      .send({
        model: "gpt-test",
        messages: [{ role: "user", content: "I prefer PostgreSQL" }],
      });

    expect(res.status).toBe(200);
    expect(upstreamCalled).toBe(true);
    expect(res.body.choices[0].message.content).toBe("Hello from upstream");
  });
});
