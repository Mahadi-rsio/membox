/**
 * Unit tests for the MCP layer (no live DB required):
 *  - session marker parsing + session-scope derivation
 *  - session store lifecycle
 *  - current-context tracker + lexical semantic search
 *  - GatewayClient HTTP behavior (mocked fetch)
 *  - RememberClient processMessage flow (mocked gateway)
 */
import { describe, expect, it, beforeEach } from "bun:test";
import { parseSessionMarker, withSessionMarker } from "../src/memory/session-marker";
import {
  isValidSessionId,
  memoryScopeForSession,
  resolveSession,
} from "../src/memory/session-scope";
import { MemorySessionStore, generateSessionId } from "../src/mcp/session";
import { ContextTracker, LexicalContextSearcher } from "../src/mcp/context";
import { GatewayClient, GatewayError } from "../src/mcp/gateway-client";
import { RememberClient } from "../src/mcp/index";

describe("session marker", () => {
  it("extracts a leading marker and strips it", () => {
    const { sessionId, cleanText, hadMarker } = parseSessionMarker(
      "___$$(sess_123)$$___What is my name?"
    );
    expect(sessionId).toBe("sess_123");
    expect(cleanText).toBe("What is my name?");
    expect(hadMarker).toBe(true);
  });

  it("returns null marker for plain messages", () => {
    const { sessionId, cleanText, hadMarker } = parseSessionMarker("Hello there");
    expect(sessionId).toBeNull();
    expect(cleanText).toBe("Hello there");
    expect(hadMarker).toBe(false);
  });

  it("round-trips via withSessionMarker", () => {
    const marked = withSessionMarker("sess_9", "My name is Mahadi");
    const parsed = parseSessionMarker(marked);
    expect(parsed.sessionId).toBe("sess_9");
    expect(parsed.cleanText).toBe("My name is Mahadi");
  });
});

describe("session scope", () => {
  it("rejects malformed session ids", () => {
    expect(isValidSessionId("bad id with spaces")).toBe(false);
    expect(isValidSessionId("")).toBe(false);
    expect(isValidSessionId("a".repeat(129))).toBe(false);
    expect(isValidSessionId("sess_ok-1_A")).toBe(true);
  });

  it("preserves base user when no session", () => {
    expect(memoryScopeForSession("test-user", null)).toBe("test-user");
    expect(memoryScopeForSession("test-user", undefined)).toBe("test-user");
    expect(memoryScopeForSession("test-user", "")).toBe("test-user");
  });

  it("is stable for the same session and isolated between sessions", () => {
    const a1 = memoryScopeForSession("user-x", "sess_1");
    const a2 = memoryScopeForSession("user-x", "sess_1");
    const b = memoryScopeForSession("user-x", "sess_2");
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
  });

  it("isolates the same session across different users", () => {
    const u1 = memoryScopeForSession("user-x", "sess_1");
    const u2 = memoryScopeForSession("user-y", "sess_1");
    expect(u1).not.toBe(u2);
  });

  it("resolveSession prefers explicit over marker and strips marker", () => {
    const explicit = resolveSession("sess_explicit", "___$$(sess_marker)$$___hi");
    expect(explicit.sessionId).toBe("sess_explicit");
    expect(explicit.cleanMessage).toBe("___$$(sess_marker)$$___hi");

    const fromMarker = resolveSession(null, "___$$(sess_marker)$$___What is my name?");
    expect(fromMarker.sessionId).toBe("sess_marker");
    expect(fromMarker.cleanMessage).toBe("What is my name?");
  });
});

describe("session store", () => {
  it("creates a stable session id and reuses on lookup", () => {
    const store = new MemorySessionStore();
    const s1 = store.create();
    const s2 = store.get(s1.sessionId);
    expect(s1.sessionId).toMatch(/^sess_/);
    expect(s2?.sessionId).toBe(s1.sessionId);
  });

  it("reuses a provided valid session id", () => {
    const store = new MemorySessionStore();
    const s = store.create("sess_mine");
    expect(s.sessionId).toBe("sess_mine");
  });

  it("touch updates updatedAt and delete removes", () => {
    const store = new MemorySessionStore();
    const s = store.create("sess_t");
    expect(store.touch("sess_t")?.updatedAt).toBeTruthy();
    expect(store.delete("sess_t")).toBe(true);
    expect(store.get("sess_t")).toBeNull();
  });

  it("generates unique ids", () => {
    const a = generateSessionId();
    const b = generateSessionId();
    expect(a).not.toBe(b);
  });
});

describe("context tracker", () => {
  it("records and returns messages in order", () => {
    const ctx = new ContextTracker();
    ctx.record("s", { role: "user", content: "hi" });
    ctx.record("s", { role: "assistant", content: "hello" });
    const list = ctx.get("s");
    expect(list.map((m) => m.content)).toEqual(["hi", "hello"]);
    expect(ctx.get("missing")).toEqual([]);
  });

  it("caps messages per session", () => {
    const ctx = new ContextTracker({ maxMessagesPerSession: 3 });
    for (let i = 0; i < 10; i++) ctx.record("s", { role: "user", content: `m${i}` });
    expect(ctx.get("s").length).toBe(3);
    expect(ctx.get("s").at(-1)?.content).toBe("m9");
  });

  it("clear resets the session", () => {
    const ctx = new ContextTracker();
    ctx.record("s", { role: "user", content: "x" });
    ctx.clear("s");
    expect(ctx.get("s")).toEqual([]);
  });
});

describe("lexical context searcher", () => {
  it("returns only relevant messages ranked by overlap + recency", () => {
    const searcher = new LexicalContextSearcher();
    const msgs = [
      { role: "user" as const, content: "I like TypeScript for implementation" },
      { role: "user" as const, content: "What is the weather today?" },
      { role: "assistant" as const, content: "We use TypeScript across the codebase" },
    ];
    const hits = searcher.search(msgs, "TypeScript implementation", 5);
    expect(hits.some((m) => m.content.includes("TypeScript"))).toBe(true);
    expect(hits.some((m) => m.content.includes("weather"))).toBe(false);
  });

  it("returns empty for stop-word-only queries", () => {
    const searcher = new LexicalContextSearcher();
    const hits = searcher.search([{ role: "user", content: "hello there" }], "a an the", 5);
    expect(hits).toEqual([]);
  });
});

describe("GatewayClient", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends Authorization and parses JSON on success", async () => {
    globalThis.fetch = async (url: any, init: any) => {
      expect(String(url)).toContain("/v1/memory/process");
      expect((init.headers as any).Authorization).toBe("Bearer secret");
      return new Response(JSON.stringify({ session_id: "s", memory: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const client = new GatewayClient({ baseUrl: "http://localhost:8787", apiKey: "secret" });
    const res = await client.processMessage({ sessionId: "s", message: "hi" });
    expect(res.session_id).toBe("s");
  });

  it("throws GatewayError with status on non-2xx", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: { message: "bad" } }), { status: 400 });
    const client = new GatewayClient({ baseUrl: "http://localhost:8787" });
    try {
      await client.searchMemory({ sessionId: "s", query: "q" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GatewayError);
      expect((err as GatewayError).status).toBe(400);
      expect((err as GatewayError).payload?.message).toBe("bad");
    }
  });

  it("rejects oversized messages", async () => {
    const client = new GatewayClient({ baseUrl: "http://localhost:8787" });
    try {
      await client.processMessage({ sessionId: "s", message: "x".repeat(70 * 1024) });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GatewayError);
      expect((err as GatewayError).code).toBe("message_too_large");
    }
  });

  it("retries search once on network error", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (calls === 1) throw new TypeError("network");
      return new Response(JSON.stringify({ session_id: "s", query: "q", results: [] }), {
        status: 200,
      });
    };
    const client = new GatewayClient({ baseUrl: "http://localhost:8787" });
    const res = await client.searchMemory({ sessionId: "s", query: "q" });
    expect(calls).toBe(2);
    expect(res.results).toEqual([]);
  });
});

describe("RememberClient", () => {
  function fakeGateway(): GatewayClient {
    return {
      processMessage: async (p: any) => ({
        session_id: p.sessionId,
        memory: [{ content: "c", type: "fact" }],
        compiled: { messages: [{ role: "system", content: "ctx" }] },
      }),
      searchMemory: async () => ({ session_id: "", query: "", results: [] }),
      saveMemory: async () => ({}),
      updateMemory: async () => ({}),
      forgetMemory: async () => ({}),
    } as unknown as GatewayClient;
  }

  it("processes every message through the gateway", async () => {
    const seen: string[] = [];
    const gw = {
      ...fakeGateway(),
      processMessage: async (p: any) => {
        seen.push(p.message);
        return { session_id: p.sessionId, memory: [], compiled: { messages: [] } };
      },
    } as unknown as GatewayClient;
    const client = new RememberClient({ gateway: gw });
    await client.processMessage({ sessionId: "s", message: "one" });
    await client.processMessage({ sessionId: "s", message: "two" });
    await client.processMessage({ sessionId: "s", message: "three" });
    expect(seen).toEqual(["one", "two", "three"]);
  });

  it("records assistant messages into the context", () => {
    const client = new RememberClient({ gateway: fakeGateway() });
    client.recordAssistantMessage({ sessionId: "s", content: "I am an AI assistant." });
    const ctx = client.context.get("s");
    expect(ctx.some((m) => m.role === "assistant")).toBe(true);
  });

  it("returns relevant prior context on subsequent messages", async () => {
    const gw = fakeGateway();
    const client = new RememberClient({ gateway: gw });
    await client.processMessage({ sessionId: "s", message: "My favorite color is red" });
    const out = await client.processMessage({
      sessionId: "s",
      message: "What is my favorite color?",
    });
    expect(out.memoryContext).toBeDefined();
    expect(out.raw.session_id).toBe("s");
  });
});
