/**
 * Session-aware memory scoping.
 *
 * The existing Memory Gateway scopes persistent memory by a `userId` derived
 * from the authenticated API key. To support the MCP session model without
 * rewriting the memory engine, we derive a stable, isolated memory scope for
 * each (auth user, session) pair:
 *
 *   - Different sessions → different memory scope (isolation)
 *   - Same session      → same memory scope (stability across messages)
 *   - No session        → fall back to the plain API-key user id (existing
 *     `/v1/chat/completions` behavior is preserved)
 *
 * The scope is a deterministic hash, so arbitrary session ids cannot be used to
 * reach another user's or session's memory.
 */
import { createHash } from "node:crypto";
import { parseSessionMarker } from "./session-marker.js";

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Validate a session id shape. Returns true when the id is safe to use. */
export function isValidSessionId(sessionId: string): boolean {
  return typeof sessionId === "string" && SESSION_ID_RE.test(sessionId);
}

/**
 * Derive the persistent-memory scope (a `userId` for the memory engine) for a
 * given authenticated user and optional session id.
 *
 * When `sessionId` is null/empty, returns the base user id unchanged so the
 * existing non-session path keeps its exact behavior.
 */
export function memoryScopeForSession(
  baseUserId: string,
  sessionId?: string | null
): string {
  if (!sessionId) {
    return baseUserId;
  }
  const normalized = sessionId.trim();
  if (!normalized || !isValidSessionId(normalized)) {
    return baseUserId;
  }
  const digest = createHash("sha256")
    .update(`${baseUserId}:${normalized}`)
    .digest("hex");
  // Keep the scope within the userId column length (128) and readable.
  return `sess:${baseUserId.slice(0, 16)}:${digest.slice(0, 40)}`;
}

/**
 * Resolve an explicit session id against an optional inline session marker.
 *
 * Explicit structured session ids win. If neither is present, returns null.
 * Also returns the message text with any inline marker stripped.
 */
export function resolveSession(
  explicitSessionId: string | null | undefined,
  message: string
): { sessionId: string | null; cleanMessage: string } {
  let cleanMessage = message;
  let sessionId: string | null = explicitSessionId ?? null;

  if (!sessionId) {
    const parsed = parseSessionMarker(message);
    sessionId = parsed.sessionId;
    cleanMessage = parsed.cleanText;
  }

  if (sessionId && !isValidSessionId(sessionId)) {
    // Reject malformed session ids rather than silently scoping wrong.
    return { sessionId: null, cleanMessage };
  }

  return { sessionId, cleanMessage };
}
