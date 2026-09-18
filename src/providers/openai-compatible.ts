import type { AIProvider, ProviderResponse, ProviderStream } from "./base.js";

const DROP_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "content-encoding",
]);

export function filterResponseHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((v, k) => {
    if (!DROP_RESPONSE_HEADERS.has(k.toLowerCase())) {
      result[k] = v;
    }
  });
  return result;
}

export class UpstreamError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
    this.name = "UpstreamError";
  }
}

export class OpenAICompatibleProvider implements AIProvider {
  private baseUrl: string;
  private apiKey?: string;

  constructor(options: { baseUrl: string; apiKey?: string }) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
  }

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  private async request(
    method: string,
    path: string,
    jsonBody?: Record<string, any>
  ): Promise<ProviderResponse> {
    const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    try {
      const response = await fetch(url, {
        method,
        headers: this.authHeaders(),
        body: jsonBody ? JSON.stringify(jsonBody) : undefined,
      });

      const arrayBuffer = await response.arrayBuffer();
      const content = new Uint8Array(arrayBuffer);

      return {
        statusCode: response.status,
        content,
        headers: filterResponseHeaders(response.headers),
        mediaType: response.headers.get("content-type"),
      };
    } catch (err) {
      throw new UpstreamError(`upstream request failed: ${err}`, err);
    }
  }

  async chat(body: Record<string, any>): Promise<ProviderResponse> {
    return await this.request("POST", "/chat/completions", body);
  }

  async responses(body: Record<string, any>): Promise<ProviderResponse> {
    return await this.request("POST", "/responses", body);
  }

  async models(): Promise<ProviderResponse> {
    return await this.request("GET", "/models");
  }

  async openStream(path: string, body: Record<string, any>): Promise<ProviderStream> {
    const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: this.authHeaders(),
        body: JSON.stringify(body),
      });

      // A rejected stream request returns a plain JSON error body, not SSE.
      // Capture it so the caller can log the provider's actual reason.
      let errorBody: Uint8Array | undefined;
      if (response.status >= 400) {
        try {
          errorBody = new Uint8Array(await response.arrayBuffer());
        } catch {
          errorBody = undefined;
        }
      }

      return {
        statusCode: response.status,
        headers: filterResponseHeaders(response.headers),
        mediaType: response.headers.get("content-type"),
        body: response.body,
        errorBody,
      };
    } catch (err) {
      throw new UpstreamError(`upstream stream failed: ${err}`, err);
    }
  }
}
