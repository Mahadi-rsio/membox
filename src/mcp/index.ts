/**
 * Public MCP integration API.
 *
 * Exposes the high-level `processMessage` flow and a `RememberClient` that an
 * application can use to integrate the MCP layer with an AI provider:
 *
 *   const result = await remember.processMessage({ sessionId, message, context });
 *   const aiMessages = [
 *     ...result.relevantContext,
 *     ...result.memoryContext,
 *     { role: "user", content: message },
 *   ];
 *
 * The MCP layer:
 *   - updates current context
 *   - runs current-context semantic search
 *   - calls the Gateway for persistent-memory processing
 *   - returns the compiled context
 */
import { GatewayClient } from "./gateway-client";
import { ContextTracker } from "./context";
import { MemorySessionStore, type SessionStore } from "./session";
import type { ContextMessage, GatewayMessage } from "./types";

export interface RememberClientOptions {
  gateway?: GatewayClient;
  sessions?: SessionStore;
  context?: ContextTracker;
}

export interface ProcessMessageOptions {
  sessionId: string;
  message: string;
  context?: Array<{ role: "user" | "assistant" | "system"; content: string }>;
}

export interface ProcessMessageOutput {
  /** The persistent memories returned by the Gateway. */
  memoryContext: Array<Record<string, any>>;
  /** Relevant prior messages found by current-context search. */
  relevantContext: ContextMessage[];
  /** Structured compiled messages ready for the AI request. */
  compiled: Array<Record<string, any>>;
  /** Raw result from the Gateway. */
  raw: any;
}

export class RememberClient {
  readonly gateway: GatewayClient;
  readonly sessions: SessionStore;
  readonly context: ContextTracker;

  constructor(options: RememberClientOptions = {}) {
    this.gateway = options.gateway ?? new GatewayClient();
    this.sessions = options.sessions ?? new MemorySessionStore();
    this.context = options.context ?? new ContextTracker();
  }

  /** Create a stable session. */
  createSession(sessionId?: string): { session_id: string } {
    const session = this.sessions.create(sessionId);
    return { session_id: session.sessionId };
  }

  /**
   * Mandatory every-message path.
   *
   * 1. Ensure the session exists (create on first use).
   * 2. Record the user message into the current context.
   * 3. Run current-context semantic search against prior context.
   * 4. Call the Gateway with the message + relevant context.
   * 5. Return the compiled memory/context.
   */
  async processMessage(options: ProcessMessageOptions): Promise<ProcessMessageOutput> {
    const sessionId = options.sessionId;
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = this.sessions.create(sessionId);
    }
    this.sessions.touch(sessionId);

    // Record the new user message into the current context.
    this.context.record(sessionId, { role: "user", content: options.message });

    // Current-context semantic search: surface only the relevant prior messages
    // rather than sending the entire history to the Gateway.
    const prior = this.context.get(sessionId).filter((m) => m.content !== options.message);
    const relevantContext = this.context.search(
      sessionId,
      options.message,
      10
    );

    // Build the context block sent to the Gateway (relevant prior context only).
    const contextBlock: GatewayMessage[] = (relevantContext.length > 0
      ? relevantContext
      : prior.slice(-5)
    ).map((m) => ({ role: m.role, content: m.content }));

    const raw = await this.gateway.processMessage({
      sessionId,
      message: options.message,
      context: contextBlock,
    });

    return {
      memoryContext: raw.memory ?? [],
      relevantContext,
      compiled: raw.compiled?.messages ?? [],
      raw,
    };
  }

  /** Record the assistant's response into the current context. */
  recordAssistantMessage(params: { sessionId: string; content: string }): void {
    this.context.record(params.sessionId, { role: "assistant", content: params.content });
  }
}

/** Convenience singleton constructed from environment defaults. */
export function createRememberClient(options?: RememberClientOptions): RememberClient {
  return new RememberClient(options);
}
