/**
 * Shared types for the Remember MCP integration.
 *
 * These types describe the boundary between the MCP layer (session tracking,
 * current-conversation tracking, current-context search, MCP tools, and Gateway
 * communication) and the Memory Gateway (persistent memory). The Gateway remains
 * the single source of truth for persistent memory; the MCP never touches the
 * database directly.
 */

/** Minimum shape of a tracked session. */
export interface Session {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
}

/** A single message in the current (live) conversation context. */
export interface ContextMessage {
  role: "user" | "assistant" | "system";
  content: string;
  messageId?: string;
  timestamp?: string;
}

/** Role accepted by the Gateway memory endpoints. */
export type MemoryMessageRole = "user" | "assistant" | "system";

/** A message sent to the Gateway for every-message processing. */
export interface GatewayMessage {
  role: MemoryMessageRole;
  content: string;
}

/** Context block passed to the Gateway alongside a message. */
export type GatewayContext = GatewayMessage[];

/** A single persistent memory record returned by the Gateway. */
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

/** The compiled context the caller should feed to the AI provider. */
export interface GatewayCompiledContext {
  messages: Array<Record<string, any>>;
  totalTokens?: number;
  canonicalItemsUsed?: number;
  shortTermItemsUsed?: number;
}

/** Result of the Gateway `POST /v1/memory/process` endpoint. */
export interface ProcessMessageResult {
  session_id: string;
  /** Persistent memories retrieved for the message. */
  memory: GatewayMemory[];
  /** Human-readable compiled context. */
  compiled_context?: string;
  /** Structured compiled context suitable for building an AI request. */
  compiled?: GatewayCompiledContext;
}

/** Result of the Gateway `POST /v1/memory/search` endpoint. */
export interface SearchMemoryResult {
  session_id: string;
  query: string;
  results: GatewayMemory[];
}

/** Result of the Gateway `POST /v1/memory/save` / `update` endpoints. */
export interface SaveMemoryResult {
  session_id: string;
  action: string;
  reason?: string;
  memory?: GatewayMemory | null;
  superseded?: GatewayMemory | null;
}

/** Result of the Gateway `POST /v1/memory/forget` endpoint. */
export interface ForgetMemoryResult {
  session_id: string;
  action: string;
  removed: GatewayMemory[];
}

/** Structured error thrown by the GatewayClient on non-2xx responses. */
export interface GatewayErrorPayload {
  message?: string;
  code?: string;
  type?: string;
}
