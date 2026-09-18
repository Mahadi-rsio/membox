import { Router } from "express";
import { Readable } from "node:stream";
import { getDb } from "../db";
import { getRedis } from "../cache";
import { getEnv } from "../http";
import { createContextStoreFromRedis } from "../memory/context-store";
import { OpenAICompatibleProvider, UpstreamError } from "../providers/openai-compatible";
import { createMemoryAIAdapter } from "../providers/memory-ai";
import { archiveRequestAsync } from "../storage/archive";
import { compileContext } from "../context/compiler";
import { checkAuth, isAuthUser, type AuthUser } from "./auth";
import { checkRateLimit } from "./rate-limit";
import type { ExtractionFallbackOptions } from "../memory/extractor";
import { warn, info } from "../log";

export const v1Router = Router();

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

function getGroqFallback(env: any): ExtractionFallbackOptions | null {
  const apiKey = env.GROQ_API_KEY;
  if (!apiKey) {
    info("groq", "connection NOT CONFIGURED (no GROQ_API_KEY); memory extraction is local-only", {
      baseUrl: env.GROQ_BASE_URL,
      model: env.GROQ_EXTRACTION_MODEL,
    });
    return null;
  }
  info("groq", "connection CONFIGURED (key present)", {
    baseUrl: env.GROQ_BASE_URL,
    model: env.GROQ_EXTRACTION_MODEL,
  });
  return {
    groqApiKey: apiKey,
    groqBaseUrl: env.GROQ_BASE_URL,
    groqModel: env.GROQ_EXTRACTION_MODEL,
  };
}

function getProvider(env: any): OpenAICompatibleProvider {
  const baseUrl = env.UPSTREAM_BASE_URL || "https://api.openai.com/v1";
  const apiKey = env.UPSTREAM_API_KEY;
  return new OpenAICompatibleProvider({ baseUrl, apiKey });
}

function badJsonError(res: any) {
  return res.status(400).json({
    error: {
      message: "Request body must be valid JSON",
      type: "invalid_request_error",
      code: "invalid_json",
    },
  });
}

function upstreamErrorResponse(res: any) {
  return res.status(502).json({
    error: {
      message: "Failed to reach upstream AI provider",
      type: "upstream_error",
      code: "upstream_unreachable",
    },
  });
}

async function prepareUpstreamBody(
  req: any,
  env: any,
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
      db = getDb(env);
    } catch {}

    const memoryAi = createMemoryAIAdapter(env);

    let budgetVal: number | undefined = undefined;
    const rawBudget = body.context_budget ?? req.header("x-context-budget") ?? env.CONTEXT_BUDGET;
    if (rawBudget !== undefined) {
      const parsed = Number(rawBudget);
      if (!Number.isNaN(parsed) && parsed > 0) {
        budgetVal = parsed;
      }
    }

    const compiled = await compileContext(db, messages, userId, {
      budget: budgetVal,
      memoryAi,
      contextStore: createContextStoreFromRedis(getRedis(env)),
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
v1Router.get("/models", async (req, res) => {
  const auth = checkAuth(req, res);
  if (!isAuthUser(auth)) return auth;

  const rlResp = await checkRateLimit(req, res);
  if (rlResp) return rlResp;

  const env = getEnv(req);
  const provider = getProvider(env);
  try {
    const result = await provider.models();
    res
      .status(result.statusCode)
      .set({ ...result.headers, "Content-Type": result.mediaType || "application/json" })
      .send(Buffer.from(result.content));
  } catch (err: any) {
    return upstreamErrorResponse(res);
  }
});

// POST /v1/chat/completions
v1Router.post("/chat/completions", async (req, res) => {
  const auth = checkAuth(req, res);
  if (!isAuthUser(auth)) return auth;

  const rlResp = await checkRateLimit(req, res);
  if (rlResp) return rlResp;

  let body: Record<string, any> = req.body;
  if (typeof body !== "object" || body === null) {
    return badJsonError(res);
  }

  const env = getEnv(req);

  // Archive and background memory extraction
  try {
    const db = getDb(env);
    const memoryAi = createMemoryAIAdapter(env);

    const archiveTask = archiveRequestAsync(db, body, {
      userId: auth.userId,
      apiKey: auth.apiKey,
      memoryAi,
      contextStore: createContextStoreFromRedis(getRedis(env)),
      groq: getGroqFallback(env),
    }).catch(() => {});
    // Run in the background; never block the response on memory work.
    archiveTask;
  } catch {}

  const upstreamBody = await prepareUpstreamBody(req, env, body, auth.userId);
  const provider = getProvider(env);

  if (upstreamBody.stream) {
    try {
      const streamResult = await provider.openStream("/chat/completions", upstreamBody);
      if (streamResult.statusCode >= 400) {
        logUpstreamError("/chat/completions", streamResult.statusCode, streamResult.errorBody);
      }
      res
        .status(streamResult.statusCode)
        .set({ ...streamResult.headers, "Content-Type": streamResult.mediaType || "text/event-stream" });
      if (streamResult.body) {
        Readable.fromWeb(streamResult.body as any).pipe(res);
      } else {
        res.end();
      }
      return;
    } catch (err) {
      return upstreamErrorResponse(res);
    }
  }

  try {
    const result = await provider.chat(upstreamBody);
    if (result.statusCode >= 400) {
      logUpstreamError("/chat/completions", result.statusCode, result.content);
    }
    res
      .status(result.statusCode)
      .set({ ...result.headers, "Content-Type": result.mediaType || "application/json" })
      .send(Buffer.from(result.content));
  } catch (err) {
    return upstreamErrorResponse(res);
  }
});

// POST /v1/responses
v1Router.post("/responses", async (req, res) => {
  const auth = checkAuth(req, res);
  if (!isAuthUser(auth)) return auth;

  const rlResp = await checkRateLimit(req, res);
  if (rlResp) return rlResp;

  let body: Record<string, any> = req.body;
  if (typeof body !== "object" || body === null) {
    return badJsonError(res);
  }

  const env = getEnv(req);

  // Archive in background
  try {
    const db = getDb(env);
    const memoryAi = createMemoryAIAdapter(env);

    const archiveTask = archiveRequestAsync(db, body, {
      userId: auth.userId,
      apiKey: auth.apiKey,
      memoryAi,
      contextStore: createContextStoreFromRedis(getRedis(env)),
      groq: getGroqFallback(env),
    }).catch(() => {});
    archiveTask;
  } catch {}

  const upstreamBody = await prepareUpstreamBody(req, env, body, auth.userId);
  const provider = getProvider(env);

  if (upstreamBody.stream) {
    try {
      const streamResult = await provider.openStream("/responses", upstreamBody);
      if (streamResult.statusCode >= 400) {
        logUpstreamError("/responses", streamResult.statusCode, streamResult.errorBody);
      }
      res
        .status(streamResult.statusCode)
        .set({ ...streamResult.headers, "Content-Type": streamResult.mediaType || "text/event-stream" });
      if (streamResult.body) {
        Readable.fromWeb(streamResult.body as any).pipe(res);
      } else {
        res.end();
      }
      return;
    } catch (err) {
      return upstreamErrorResponse(err);
    }
  }

  try {
    const result = await provider.responses(upstreamBody);
    if (result.statusCode >= 400) {
      logUpstreamError("/responses", result.statusCode, result.content);
    }
    res
      .status(result.statusCode)
      .set({ ...result.headers, "Content-Type": result.mediaType || "application/json" })
      .send(Buffer.from(result.content));
  } catch (err) {
    return upstreamErrorResponse(err);
  }
});
