/**
 * Session tracking for the MCP layer.
 *
 * The MCP layer owns session lifecycle. A session must remain stable across
 * multiple messages — we never create a new session for every message. If the
 * host already provides a session id, we reuse it.
 *
 * The default store is in-memory (suitable for a single worker instance). It can
 * be replaced with a persistent store without changing the tool layer.
 */
import type { Session } from "./types";

export interface SessionStore {
  create(sessionId?: string): Session;
  get(sessionId: string): Session | null;
  touch(sessionId: string): Session | null;
  delete(sessionId: string): boolean;
}

export function generateSessionId(): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/g, "")
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `sess_${rand}`;
}

/** In-memory session registry. */
export class MemorySessionStore implements SessionStore {
  private sessions = new Map<string, Session>();

  create(sessionId?: string): Session {
    const id = sessionId && isValidSessionId(sessionId) ? sessionId : generateSessionId();
    const now = new Date().toISOString();
    const session: Session = { sessionId: id, createdAt: now, updatedAt: now };
    this.sessions.set(id, session);
    return session;
  }

  get(sessionId: string): Session | null {
    return this.sessions.get(sessionId) ?? null;
  }

  touch(sessionId: string): Session | null {
    const s = this.sessions.get(sessionId);
    if (!s) return null;
    s.updatedAt = new Date().toISOString();
    return s;
  }

  delete(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  /** Number of tracked sessions (used by tests). */
  get size(): number {
    return this.sessions.size;
  }
}

/** Validate the shape of a host-provided session id. */
export function isValidSessionId(sessionId: string): boolean {
  return typeof sessionId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(sessionId);
}
