/**
 * Current-conversation tracking and current-context semantic search.
 *
 * The MCP maintains the live conversation context (user + assistant messages)
 * per session. For every new message the MCP records/updates the context, then
 * runs a current-context search against it to surface only the relevant prior
 * messages rather than blindly sending the entire history to the Gateway.
 *
 * The first implementation uses a deterministic lexical relevance mechanism
 * (keyword overlap + recency weighting). The `ContextSearcher` interface is
 * designed so a real embedding/vector implementation can replace it later
 * without changing the caller.
 */
import type { ContextMessage } from "./types";

export interface ContextSearcher {
  search(
    messages: ContextMessage[],
    query: string,
    limit?: number
  ): ContextMessage[];
}

/** Stop words ignored when computing keyword relevance. */
const STOP = new Set(
  (
    "a an and are as at be but by for from had has have how i if in into is it its " +
    "my not of on or our that the their them then there these they this to was we what " +
    "when where which who why will with you your do does did doing can could should would " +
    "about over under than so just very can't don't"
  ).split(/\s+/)
);

function tokenize(text: string): string[] {
  return String(text)
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.filter((t) => t.length > 1 && !STOP.has(t)) ?? [];
}

function scoreRelevance(message: ContextMessage, queryTerms: Set<string>, index: number, total: number): number {
  if (!message.content) return 0;
  const terms = tokenize(message.content);
  if (terms.length === 0) return 0;

  let overlap = 0;
  for (const t of terms) {
    if (queryTerms.has(t)) overlap++;
  }
  // Keyword overlap ratio, boosted for longer unique matches.
  const keywordScore = overlap / Math.max(1, queryTerms.size);
  // Only messages that actually overlap the query are considered relevant.
  if (keywordScore === 0) return 0;

  // Recency: more recent messages are more likely relevant to the current turn.
  const recency = total > 0 ? (index + 1) / total : 1;

  // Questions are worth a small boost when they contain query terms.
  const isQuestion = /[?？]$/.test(message.content.trim()) ? 0.1 : 0;

  return keywordScore + 0.05 * recency + isQuestion;
}

/** Deterministic lexical relevance searcher (swap-in point for embeddings). */
export class LexicalContextSearcher implements ContextSearcher {
  search(messages: ContextMessage[], query: string, limit = 5): ContextMessage[] {
    if (!query || !messages || messages.length === 0) return [];
    const queryTerms = new Set(tokenize(query));
    if (queryTerms.size === 0) return [];

    const scored = messages
      .map((m, i) => ({
        message: m,
        score: scoreRelevance(m, queryTerms, i, messages.length),
      }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);

    return scored.slice(0, limit).map((s) => s.message);
  }
}

/**
 * In-memory per-session conversation tracker.
 */
export class ContextTracker {
  private sessions = new Map<string, ContextMessage[]>();
  private readonly maxPerSession: number;

  constructor(opts?: { maxMessagesPerSession?: number; searcher?: ContextSearcher }) {
    this.maxPerSession = opts?.maxMessagesPerSession ?? 100;
    this.searcher = opts?.searcher ?? new LexicalContextSearcher();
  }

  private readonly searcher: ContextSearcher;

  /** Record a message (user/assistant/system) into the session's context. */
  record(sessionId: string, message: ContextMessage): void {
    let list = this.sessions.get(sessionId);
    if (!list) {
      list = [];
      this.sessions.set(sessionId, list);
    }
    list.push({
      ...message,
      timestamp: message.timestamp ?? new Date().toISOString(),
    });
    if (list.length > this.maxPerSession) {
      list.splice(0, list.length - this.maxPerSession);
    }
  }

  /** Get the full tracked context for a session. */
  get(sessionId: string): ContextMessage[] {
    return this.sessions.get(sessionId) ?? [];
  }

  /** Clear the context for a session. */
  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * Search the current conversation context for messages relevant to `query`.
   * Returns only relevant messages, never the entire history.
   */
  search(sessionId: string, query: string, limit = 5): ContextMessage[] {
    return this.searcher.search(this.get(sessionId), query, limit);
  }
}
