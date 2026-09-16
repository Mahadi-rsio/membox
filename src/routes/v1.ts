import { Hono } from "hono";
import type { HonoContext } from "../env";
import { getDb } from "../db";
import { getRedis } from "../cache";
import { createContextStoreFromRedis } from "../memory/context-store";
import { OpenAICompatibleProvider, UpstreamError } from "../providers/openai-compatible";
import { createMemoryAIAdapter } from "../providers/memory-ai";
import { archiveRequestAsync } from "../storage/archive";
import { compileContext } from "../context/compiler";
import { checkAuth, type AuthUser } from "./auth";
import { checkRateLimit } from "./rate-limit";
import type { ExtractionFallbackOptions } from "../memory/extractor";
import { warn, info } from "../log";

export const v1Router = new Hono<HonoContext>();

function logUpstreamError(path: string, statusCode: number, content: Uint8Array | undefined) {
  let body = "";
  try {
    body = content ? new TextDecoder().decode(content.slice(0, 1024)) : "";
  } catch {
    body = "<undecodable body>";
  }
  warn("upstream", "upstream returned an error", {
    path,
    status: statusCode,
    body: body || "<empty body>",
  });
}

function getGroqFallback(c: any): ExtractionFallbackOptions | null {
  const apiKey = c.env.GROQ_API_KEY;
  if (!apiKey) {
    info("groq", "connection NOT CONFIGURED (no GROQ_API_KEY); memory extraction is local-only", {
      baseUrl: c.env.GROQ_BASE_URL,
      model: c.env.GROQ_EXTRACTION_MODEL,
    });
    return null;
  }
  info("groq", "connection CONFIGURED (key present)", {
    baseUrl: c.env.GROQ_BASE_URL,
    model: c.env.GROQ_EXTRACTION_MODEL,
  });
  return {
    groqApiKey: apiKey,
    groqBaseUrl: c.env.GROQ_BASE_URL,
    groqModel: c.env.GROQ_EXTRACTION_MODEL,
  };
}

function getProvider(c: any): OpenAICompatibleProvider {
  const baseUrl = c.env.UPSTREAM_BASE_URL || "https://api.openai.com/v1";
  const apiKey = c.env.UPSTREAM_API_KEY;
  return new OpenAICompatibleProvider({ baseUrl, apiKey });
}

function badJsonError() {
  return Response.json(
    {
      error: {
        message: "Request body must be valid JSON",
        type: "invalid_request_error",
        code: "invalid_json",
      },
    },
    { status: 400 }
  );
}

function upstreamErrorResponse(exc: any) {
  return Response.json(
    {
      error: {
        message: "Failed to reach upstream AI provider",
        type: "upstream_error",
        code: "upstream_unreachable",
      },
    },
    { status: 502 }
  );
}

async function prepareUpstreamBody(
  c: any,
  body: Record<string, any>,
  userId: string
): Promise<Record<string, any>> {
  const messages = body.messages;
  if (!Array.isArray(messages)) {
    return body;
  }

  try {
    let db = null;
    try {
      db = getDb(c.env);
    } catch {}

    const memoryAi = createMemoryAIAdapter(c.env);

    let budgetVal: number | undefined = undefined;
    const rawBudget = body.context_budget ?? c.req.header("x-context-budget") ?? c.env.CONTEXT_BUDGET;
    if (rawBudget !== undefined) {
      const parsed = Number(rawBudget);
      if (!Number.isNaN(parsed) && parsed > 0) {
        budgetVal = parsed;
      }
    }

    const compiled = await compileContext(db, messages, userId, {
      budget: budgetVal,
      memoryAi,
      contextStore: createContextStoreFromRedis(getRedis(c.env)),
      persistSnapshot: true,
    });

    return {
      ...body,
      messages: compiled.messages,
    };
  } catch {
    // Fail-open to original body on context compilation failure
    return body;
  }
}

// GET /v1/models
v1Router.get("/models", async (c) => {
  const auth = checkAuth(c);
  if (auth instanceof Response) return auth;

  const rlResp = await checkRateLimit(c);
  if (rlResp) return rlResp;

  const provider = getProvider(c);
  try {
    const result = await provider.models();
    return new Response(result.content, {
      status: result.statusCode,
      headers: {
        ...result.headers,
        "Content-Type": result.mediaType || "application/json",
      },
    });
  } catch (err: any) {
    return upstreamErrorResponse(err);
  }
});

// POST /v1/chat/completions
v1Router.post("/chat/completions", async (c) => {
  const auth = checkAuth(c);
  if (auth instanceof Response) return auth;

  const rlResp = await checkRateLimit(c);
  if (rlResp) return rlResp;

  let body: Record<string, any>;
  try {
    body = await c.req.json();
  } catch {
    return badJsonError();
  }

  if (typeof body !== "object" || body === null) {
    return badJsonError();
  }

  // Archive and background memory extraction
  try {
    const db = getDb(c.env);
    const memoryAi = createMemoryAIAdapter(c.env);

    const archiveTask = archiveRequestAsync(db, body, {
      userId: auth.userId,
      apiKey: auth.apiKey,
      memoryAi,
      contextStore: createContextStoreFromRedis(getRedis(c.env)),
      groq: getGroqFallback(c),
    }).catch(() => {});
    if (c.executionCtx && typeof c.executionCtx.waitUntil === "function") {
      c.executionCtx.waitUntil(archiveTask);
    } else {
      archiveTask;
    }
  } catch {}

  const upstreamBody = await prepareUpstreamBody(c, body, auth.userId);
  const provider = getProvider(c);

  if (upstreamBody.stream) {
    try {
      const streamResult = await provider.openStream("/chat/completions", upstreamBody);
      if (streamResult.statusCode >= 400) {
        logUpstreamError("/chat/completions", streamResult.statusCode, streamResult.errorBody);
      }
      return new Response(streamResult.body, {
        status: streamResult.statusCode,
        headers: {
          ...streamResult.headers,
          "Content-Type": streamResult.mediaType || "text/event-stream",
        },
      });
    } catch (err) {
      return upstreamErrorResponse(err);
    }
  }

  try {
    const result = await provider.chat(upstreamBody);
    if (result.statusCode >= 400) {
      logUpstreamError("/chat/completions", result.statusCode, result.content);
    }
    return new Response(result.content, {
      status: result.statusCode,
      headers: {
        ...result.headers,
        "Content-Type": result.mediaType || "application/json",
      },
    });
  } catch (err) {
    return upstreamErrorResponse(err);
  }
});

// POST /v1/responses
v1Router.post("/responses", async (c) => {
  const auth = checkAuth(c);
  if (auth instanceof Response) return auth;

  const rlResp = await checkRateLimit(c);
  if (rlResp) return rlResp;

  let body: Record<string, any>;
  try {
    body = await c.req.json();
  } catch {
    return badJsonError();
  }

  if (typeof body !== "object" || body === null) {
    return badJsonError();
  }

  // Archive in background
  try {
    const db = getDb(c.env);
    const memoryAi = createMemoryAIAdapter(c.env);

    const archiveTask = archiveRequestAsync(db, body, {
      userId: auth.userId,
      apiKey: auth.apiKey,
      memoryAi,
      contextStore: createContextStoreFromRedis(getRedis(c.env)),
      groq: getGroqFallback(c),
    }).catch(() => {});
    if (c.executionCtx && typeof c.executionCtx.waitUntil === "function") {
      c.executionCtx.waitUntil(archiveTask);
    } else {
      archiveTask;
    }
  } catch {}

  const upstreamBody = await prepareUpstreamBody(c, body, auth.userId);
  const provider = getProvider(c);

  if (upstreamBody.stream) {
    try {
      const streamResult = await provider.openStream("/responses", upstreamBody);
      if (streamResult.statusCode >= 400) {
        logUpstreamError("/responses", streamResult.statusCode, streamResult.errorBody);
      }
      return new Response(streamResult.body, {
        status: streamResult.statusCode,
        headers: {
          ...streamResult.headers,
          "Content-Type": streamResult.mediaType || "text/event-stream",
        },
      });
    } catch (err) {
      return upstreamErrorResponse(err);
    }
  }

  try {
    const result = await provider.responses(upstreamBody);
    if (result.statusCode >= 400) {
      logUpstreamError("/responses", result.statusCode, result.content);
    }
    return new Response(result.content, {
      status: result.statusCode,
      headers: {
        ...result.headers,
        "Content-Type": result.mediaType || "application/json",
      },
    });
  } catch (err) {
    return upstreamErrorResponse(err);
  }
});
