import { Router } from "express";
import { getDb } from "../db";
import { getRedis } from "../cache";
import { getEnv } from "../http";
import { createContextStoreFromRedis } from "../memory/context-store";
import { createMemoryAIAdapter } from "../providers/memory-ai";
import { archiveRequest } from "../storage/archive";
import { compileContext } from "../context/compiler";
import { memoryScopeForSession, resolveSession, isValidSessionId } from "../memory/session-scope";
import {
  saveMemory,
  updateMemory,
  forgetMemory,
  searchMemory,
} from "../memory/memory-ops";
import { checkAuth, isAuthUser } from "./auth";
export interface GatewayMemory {
  entity?: string | null;
  attribute?: string | null;
  value?: string | null;
  content?: string;
  type?: string;
  scope?: string;
  status?: string;
  confidence?: number;
  importance?: number;
  stability?: number;
  topicKey?: string;
  id?: number;
}
import { info, warn } from "../log";

export const memoryRouter = Router();

function badRequest(res: any, message: string, code = "invalid_request") {
  return res.status(400).json({
    error: { message, type: "invalid_request_error", code },
  });
}

function serializeMemoryItem(item: any): GatewayMemory {
  return {
    id: item.id,
    entity: item.subject || null,
    attribute: item.predicate || null,
    value: item.value || null,
    content: item.content,
    type: item.type,
    scope: item.scope,
    status: item.status,
    confidence: item.confidence,
    importance: item.importance,
    stability: item.stability,
    topicKey: item.topicKey,
  };
}

function renderCompiledContext(memories: any[]): string {
  if (!memories || memories.length === 0) return "";
  const lines: string[] = [];
  for (const m of memories) {
    const label = [m.subject, m.predicate].filter(Boolean).join(".");
    lines.push(label ? `${label}: ${m.value || m.content}` : String(m.content || ""));
  }
  return lines.join("\n");
}

async function runMemoryPipeline(
  req: any,
  res: any,
  ctx: { userId: string; apiKey: string | null },
  body: {
    session_id?: string | null;
    message?: string;
    context?: Array<{ role: string; content: string }>;
  }
) {
  const env = getEnv(req);
  const userId = ctx.userId;
  const db = getDb(env);

  const message = typeof body.message === "string" ? body.message : "";
  if (!message.trim()) {
    return badRequest(res, "message is required and must be a non-empty string", "invalid_message");
  }

  // Session marker is a compatibility mechanism: strip it and never forward it.
  const { sessionId, cleanMessage } = resolveSession(body.session_id, message);
  const resolvedSessionId = sessionId ?? body.session_id ?? null;

  // Build the message list: prior context (if any) + the current message.
  const priorContext = Array.isArray(body.context) ? body.context : [];
  const messages: Array<Record<string, any>> = [];
  for (const msg of priorContext) {
    if (msg && typeof msg.content === "string" && msg.content.trim()) {
      messages.push({ role: msg.role === "assistant" ? "assistant" : "user", content: msg.content });
    }
  }
  messages.push({ role: "user", content: cleanMessage });

  // Every message must flow through the standard memory pipeline (archive +
  // deterministic learning + three-way analysis). Fail-open.
  const contextStore = createContextStoreFromRedis(getRedis(env));
  try {
    await archiveRequest(db, { messages }, {
      userId,
      apiKey: ctx.apiKey,
      contextStore,
      groq: getGroq(env),
    });
  } catch (err: any) {
    warn("memory-process", "memory pipeline failed; continuing", {
      error: err?.message ?? String(err),
    });
  }

  // Retrieve the relevant persistent memory for this session/user scope.
  let memoryItemsList: any[] = [];
  try {
    memoryItemsList = await searchMemory(db, { userId, query: cleanMessage, limit: 20 });
  } catch (err: any) {
    warn("memory-process", "retrieval failed; returning empty memory", {
      error: err?.message ?? String(err),
    });
  }

  // Compile a fixed-budget context for the caller using the same engine as the
  // chat path. Fail-open to the raw messages.
  let compiled: { messages: Array<Record<string, any>>; totalTokens: number } | null = null;
  try {
    const resC = await compileContext(db, messages, userId, {
      contextStore,
      memoryAi: createMemoryAIAdapter(env),
      persistSnapshot: true,
    });
    compiled = { messages: resC.messages, totalTokens: resC.totalTokens };
  } catch {
    compiled = null;
  }

  info("memory-process", "message processed by gateway", {
    userId,
    sessionId: resolvedSessionId,
    messageLen: cleanMessage.length,
    contextMessages: priorContext.length,
    memoryItems: memoryItemsList.length,
  });

  return res.json({
    session_id: resolvedSessionId,
    memory: memoryItemsList.map(serializeMemoryItem),
    compiled_context: renderCompiledContext(memoryItemsList),
    compiled: compiled
      ? {
          messages: compiled.messages,
          totalTokens: compiled.totalTokens,
        }
      : undefined,
  });
}

function getGroq(env: any) {
  const apiKey = env.GROQ_API_KEY;
  if (!apiKey) return null;
  return {
    groqApiKey: apiKey,
    groqBaseUrl: env.GROQ_BASE_URL,
    groqModel: env.GROQ_EXTRACTION_MODEL,
  };
}

// POST /v1/memory/process
memoryRouter.post("/memory/process", async (req, res) => {
  const auth = checkAuth(req, res);
  if (!isAuthUser(auth)) return auth;

  let body: any = req.body;
  if (typeof body !== "object" || body === null) {
    return badRequest(res, "Request body must be valid JSON", "invalid_json");
  }

  // Resolve the memory scope. An invalid explicit session id is rejected.
  const explicitSession = typeof body.session_id === "string" ? body.session_id : null;
  if (explicitSession && !isValidSessionId(explicitSession)) {
    return badRequest(res, "invalid session_id format", "invalid_session_id");
  }

  const memoryUserId = memoryScopeForSession(auth.userId, explicitSession);

  return runMemoryPipeline(req, res, { userId: memoryUserId, apiKey: auth.apiKey }, body);
});

// POST /v1/memory/search
memoryRouter.post("/memory/search", async (req, res) => {
  const auth = checkAuth(req, res);
  if (!isAuthUser(auth)) return auth;

  let body: any = req.body;
  if (typeof body !== "object" || body === null) {
    return badRequest(res, "Request body must be valid JSON", "invalid_json");
  }

  const sessionId = typeof body.session_id === "string" ? body.session_id : null;
  if (sessionId && !isValidSessionId(sessionId)) {
    return badRequest(res, "invalid session_id format", "invalid_session_id");
  }
  const query = typeof body.query === "string" ? body.query : "";
  if (!query.trim()) {
    return badRequest(res, "query is required", "invalid_query");
  }

  const memoryUserId = memoryScopeForSession(auth.userId, sessionId);
  let results: any[] = [];
  try {
    const db = getDb(getEnv(req));
    results = await searchMemory(db, {
      userId: memoryUserId,
      query,
      limit: Number(body.limit) || 20,
    });
  } catch (err: any) {
    warn("memory-search", "search failed", { error: err?.message ?? String(err) });
  }

  return res.json({
    session_id: sessionId,
    query,
    results: results.map(serializeMemoryItem),
  });
});

// POST /v1/memory/save
memoryRouter.post("/memory/save", async (req, res) => {
  const auth = checkAuth(req, res);
  if (!isAuthUser(auth)) return auth;

  let body: any = req.body;
  if (typeof body !== "object" || body === null) {
    return badRequest(res, "Request body must be valid JSON", "invalid_json");
  }

  const sessionId = typeof body.session_id === "string" ? body.session_id : null;
  if (sessionId && !isValidSessionId(sessionId)) {
    return badRequest(res, "invalid session_id format", "invalid_session_id");
  }
  if (typeof body.value !== "string" || !body.value.trim()) {
    return badRequest(res, "value is required", "invalid_value");
  }

  const memoryUserId = memoryScopeForSession(auth.userId, sessionId);
  try {
    const db = getDb(getEnv(req));
    const result = await saveMemory(db, {
      userId: memoryUserId,
      subject: body.subject,
      attribute: body.attribute,
      value: body.value,
      type: body.type,
      scope: body.scope,
    });
    return res.json({
      session_id: sessionId,
      action: result.action,
      reason: result.reason,
      memory: result.item ? serializeMemoryItem(result.item) : null,
      superseded: result.superseded ? serializeMemoryItem(result.superseded) : null,
    });
  } catch (err: any) {
    warn("memory-save", "save failed", { error: err?.message ?? String(err) });
    return badRequest(res, "failed to save memory", "save_failed");
  }
});

// POST /v1/memory/update
memoryRouter.post("/memory/update", async (req, res) => {
  const auth = checkAuth(req, res);
  if (!isAuthUser(auth)) return auth;

  let body: any = req.body;
  if (typeof body !== "object" || body === null) {
    return badRequest(res, "Request body must be valid JSON", "invalid_json");
  }

  const sessionId = typeof body.session_id === "string" ? body.session_id : null;
  if (sessionId && !isValidSessionId(sessionId)) {
    return badRequest(res, "invalid session_id format", "invalid_session_id");
  }
  if (typeof body.value !== "string" || !body.value.trim()) {
    return badRequest(res, "value is required", "invalid_value");
  }

  const memoryUserId = memoryScopeForSession(auth.userId, sessionId);
  try {
    const db = getDb(getEnv(req));
    const result = await updateMemory(db, memoryUserId, {
      id: body.id != null ? Number(body.id) : undefined,
      topicKey: body.topic_key,
      value: body.value,
      attribute: body.attribute,
      subject: body.subject,
      type: body.type,
    });
    return res.json({
      session_id: sessionId,
      action: result.action,
      reason: result.reason,
      memory: result.item ? serializeMemoryItem(result.item) : null,
      superseded: result.superseded ? serializeMemoryItem(result.superseded) : null,
    });
  } catch (err: any) {
    warn("memory-update", "update failed", { error: err?.message ?? String(err) });
    return badRequest(res, "failed to update memory", "update_failed");
  }
});

// POST /v1/memory/forget
memoryRouter.post("/memory/forget", async (req, res) => {
  const auth = checkAuth(req, res);
  if (!isAuthUser(auth)) return auth;

  let body: any = req.body;
  if (typeof body !== "object" || body === null) {
    return badRequest(res, "Request body must be valid JSON", "invalid_json");
  }

  const sessionId = typeof body.session_id === "string" ? body.session_id : null;
  if (sessionId && !isValidSessionId(sessionId)) {
    return badRequest(res, "invalid session_id format", "invalid_session_id");
  }

  const memoryUserId = memoryScopeForSession(auth.userId, sessionId);
  try {
    const db = getDb(getEnv(req));
    const result = await forgetMemory(db, memoryUserId, {
      id: body.id != null ? Number(body.id) : undefined,
      topicKey: body.topic_key,
      attribute: body.attribute,
      content: body.content,
    });
    return res.json({
      session_id: sessionId,
      action: result.action,
      removed: result.removed.map(serializeMemoryItem),
    });
  } catch (err: any) {
    warn("memory-forget", "forget failed", { error: err?.message ?? String(err) });
    return badRequest(res, "failed to forget memory", "forget_failed");
  }
});
