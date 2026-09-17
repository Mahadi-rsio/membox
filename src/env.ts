export interface Env {
  // Neon / PostgreSQL
  DATABASE_URL?: string;
  NEON_API_KEY?: string;

  // Upstash Redis (Optional for caching / rate limiting)
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;

  // Upstream AI Provider (OpenAI / OpenRouter / etc.)
  UPSTREAM_PROVIDER?: string;
  UPSTREAM_BASE_URL?: string;
  UPSTREAM_API_KEY?: string;

  // Gateway Auth (Optional)
  GATEWAY_API_KEY?: string;

  // Gateway URL (used by the MCP layer / GatewayClient to reach the gateway)
  GATEWAY_URL?: string;

  // Model name to use for the web chat endpoint
  LIVE_MODEL?: string;

  // Context Compiler Budget
  CONTEXT_BUDGET?: string | number;

  // Optional Memory AI Compressor
  MEMORY_AI_ENABLED?: string | boolean;
  MEMORY_AI_PROVIDER?: string;
  MEMORY_AI_BASE_URL?: string;
  MEMORY_AI_MODEL?: string;
  MEMORY_AI_API_KEY?: string;

  // Groq Memory Extraction
  GROQ_API_KEY?: string;
  GROQ_BASE_URL?: string;
  GROQ_EXTRACTION_MODEL?: string;

  // Logging
  LOG_LEVEL?: string;
}

export type HonoContext = {
  Bindings: Env;
};
