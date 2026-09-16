/**
 * Reusable Gateway client for the MCP layer.
 *
 * The MCP layer never touches the Gateway database directly. All persistent
 * memory operations flow through these HTTP calls to the Memory Gateway, which
 * remains the single source of truth for persistent memory.
 *
 * Configuration comes from the environment (`GATEWAY_URL`, `GATEWAY_API_KEY`).
 * Implements request timeouts, HTTP error handling, structured errors, JSON
 * validation, and logging. Writes (save/update/forget/process) are NOT blindly
 * retried because they are not idempotent; only the idempotent read (search) is
 * retried once on transient failure.
 */
import type {
  GatewayCompiledContext,
  GatewayMemory,
  ProcessMessageResult,
  SearchMemoryResult,
  SaveMemoryResult,
  ForgetMemoryResult,
  GatewayErrorPayload,
  GatewayMessage,
} from "./types";

export interface GatewayClientOptions {
  /** Base URL of the Memory Gateway, e.g. http://localhost:8787 */
  baseUrl?: string;
  /** Service token used to authenticate MCP → Gateway. */
  apiKey?: string;
  /** Request timeout in milliseconds. Default 15000. */
  timeoutMs?: number;
  /** Optional logger. Defaults to console. */
  log?: Pick<Console, "debug" | "info" | "warn" | "error">;
}

export class GatewayError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly payload?: GatewayErrorPayload;

  constructor(message: string, status: number, payload?: GatewayErrorPayload) {
    super(message);
    this.name = "GatewayError";
    this.status = status;
    this.code = payload?.code;
    this.payload = payload;
  }
}

const DEFAULT_TIMEOUT = 15_000;
const MAX_MESSAGE_BYTES = 64 * 1024; // 64 KB max message size
const MAX_CONTEXT_MESSAGES = 40; // cap the context block sent to the gateway

const textEncoder = new TextEncoder();

function byteLength(text: string): number {
  return textEncoder.encode(text).length;
}

export class GatewayClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly log: NonNullable<GatewayClientOptions["log"]>;

  constructor(options: GatewayClientOptions = {}) {
    const url = (options.baseUrl || process.env.GATEWAY_URL || "http://localhost:8787").replace(/\/+$/, "");
    if (!/^https?:\/\//.test(url)) {
      throw new Error(`GATEWAY_URL must be an absolute http(s) URL, got: ${url}`);
    }
    this.baseUrl = url;
    this.apiKey = options.apiKey || process.env.GATEWAY_API_KEY;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;
    this.log = options.log ?? console;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  private async request<T>(
    path: string,
    method: "GET" | "POST",
    body?: unknown,
    opts?: { retries?: number }
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let lastError: unknown = null;
    const maxAttempts = (opts?.retries ?? 0) + 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await fetch(url, {
          method,
          headers: this.headers(),
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });

        if (res.status >= 200 && res.status < 300) {
          const text = await res.text();
          try {
            return JSON.parse(text) as T;
          } catch {
            throw new GatewayError("Gateway returned invalid JSON", res.status, {
              message: "invalid_json_response",
            });
          }
        }

        let payload: GatewayErrorPayload | undefined;
        try {
          const json = (await res.json()) as { error?: GatewayErrorPayload };
          payload = json?.error ?? undefined;
        } catch {
          payload = undefined;
        }
        const message = payload?.message || `Gateway request failed with status ${res.status}`;
        throw new GatewayError(message, res.status, payload);
      } catch (err: any) {
        lastError = err;
        if (err instanceof GatewayError) {
          // Do not retry non-idempotent writes or non-transient errors.
          throw err;
        }
        if (attempt < maxAttempts) {
          this.log.debug?.(`[gateway-client] retry ${attempt} for ${method} ${path}`);
          await new Promise((r) => setTimeout(r, 100 * attempt));
          continue;
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private assertMessageSize(messages: GatewayMessage[]): void {
    for (const m of messages) {
      if (byteLength(m.content) > MAX_MESSAGE_BYTES) {
        throw new GatewayError(
          `Message exceeds maximum size of ${MAX_MESSAGE_BYTES} bytes`,
          400,
          { code: "message_too_large" }
        );
      }
    }
  }

  /** Every-message processing: send the message (and context) to the Gateway. */
  async processMessage(params: {
    sessionId: string;
    message: string;
    context?: GatewayMessage[];
  }): Promise<ProcessMessageResult> {
    const context = (params.context ?? []).slice(0, MAX_CONTEXT_MESSAGES);
    this.assertMessageSize(context.concat([{ role: "user", content: params.message }]));
    return this.request<ProcessMessageResult>("/v1/memory/process", "POST", {
      session_id: params.sessionId,
      message: params.message,
      context,
    });
  }

  /** Persistent-memory search. Idempotent, retried once on transient failure. */
  async searchMemory(params: {
    sessionId: string;
    query: string;
    limit?: number;
  }): Promise<SearchMemoryResult> {
    return this.request<SearchMemoryResult>(
      "/v1/memory/search",
      "POST",
      {
        session_id: params.sessionId,
        query: params.query,
        limit: params.limit,
      },
      { retries: 1 }
    );
  }

  /** Explicitly save a fact to persistent memory. */
  async saveMemory(params: {
    sessionId: string;
    value: string;
    subject?: string;
    attribute?: string;
    type?: string;
    scope?: string;
  }): Promise<SaveMemoryResult> {
    return this.request<SaveMemoryResult>("/v1/memory/save", "POST", {
      session_id: params.sessionId,
      value: params.value,
      subject: params.subject,
      attribute: params.attribute,
      type: params.type,
      scope: params.scope,
    });
  }

  /** Update an existing memory item's value. */
  async updateMemory(params: {
    sessionId: string;
    value: string;
    id?: number;
    topicKey?: string;
    attribute?: string;
    subject?: string;
    type?: string;
  }): Promise<SaveMemoryResult> {
    return this.request<SaveMemoryResult>("/v1/memory/update", "POST", {
      session_id: params.sessionId,
      value: params.value,
      id: params.id,
      topic_key: params.topicKey,
      attribute: params.attribute,
      subject: params.subject,
      type: params.type,
    });
  }

  /** Forget (revoke) memory by id, topic, attribute, or content. */
  async forgetMemory(params: {
    sessionId: string;
    id?: number;
    topicKey?: string;
    attribute?: string;
    content?: string;
  }): Promise<ForgetMemoryResult> {
    return this.request<ForgetMemoryResult>("/v1/memory/forget", "POST", {
      session_id: params.sessionId,
      id: params.id,
      topic_key: params.topicKey,
      attribute: params.attribute,
      content: params.content,
    });
  }
}

// Re-export types consumed by callers of the client.
export type { GatewayMemory, GatewayCompiledContext, ProcessMessageResult };
