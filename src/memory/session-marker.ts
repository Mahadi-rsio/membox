/**
 * Session marker parsing.
 *
 * The existing Gateway/API path uses an inline marker to carry a session id on a
 * message when a structured `session_id` field is not available:
 *
 *   ___$$(sess_123)$$___What is my name?
 *
 * Parsing must produce:
 *   session_id  -> "sess_123"
 *   clean text  -> "What is my name?"
 *
 * The marker MUST never be forwarded to the AI as user content. It is a
 * compatibility mechanism; MCP → Gateway communication prefers structured JSON.
 */

const MARKER_RE = /^\s*___\$\$\((?<sessionId>[A-Za-z0-9_-]{1,128})\)\$\$___\s*/;

export interface ParsedSessionMarker {
  /** Extracted session id, or null when no marker is present. */
  sessionId: string | null;
  /** The message with any leading marker stripped. */
  cleanText: string;
  /** Whether a marker was actually found and stripped. */
  hadMarker: boolean;
}

/**
 * Extract a leading session marker from a message.
 *
 * When a marker is present it is removed from the text. The returned `cleanText`
 * is always safe to forward as user content.
 */
export function parseSessionMarker(message: string): ParsedSessionMarker {
  if (typeof message !== "string") {
    return { sessionId: null, cleanText: String(message ?? ""), hadMarker: false };
  }
  const match = message.match(MARKER_RE);
  if (!match || !match.groups?.sessionId) {
    return { sessionId: null, cleanText: message, hadMarker: false };
  }
  return {
    sessionId: match.groups.sessionId,
    cleanText: message.slice(match[0].length),
    hadMarker: true,
  };
}

/**
 * Prepend a session marker to a message. Used mainly for testing and for
 * emitting the legacy inline format from an MCP/application layer.
 */
export function withSessionMarker(sessionId: string, message: string): string {
  return `___$$(${sessionId})$$___${message}`;
}
