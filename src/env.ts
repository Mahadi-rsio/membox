export interface Env {
  // Self-hosted PostgreSQL (optionally behind PgBouncer)
  DATABASE_URL?: string;
  DATABASE_POOL_MAX?: string | number;

  // Direct Postgres endpoint used for migrations (bypasses PgBouncer so DDL
  // works). Falls back to DATABASE_URL when unset.
  MIGRATION_DATABASE_URL?: string;

  // Self-hosted Redis (Optional for caching / rate limiting)
  REDIS_URL?: string;

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

/**
 * Build an `Env` from `process.env`. Values that arrive as strings are mapped
 * onto the same field names used by the previous Worker bindings, so the
 * runtime behaviour is unchanged when the server is run with a `.env` file.
 */
export function getEnv(): Env {
  const env: Env = {
    DATABASE_URL: process.env.DATABASE_URL,
    DATABASE_POOL_MAX: process.env.DATABASE_POOL_MAX,
    MIGRATION_DATABASE_URL: process.env.MIGRATION_DATABASE_URL,
    REDIS_URL: process.env.REDIS_URL,
    UPSTREAM_PROVIDER: process.env.UPSTREAM_PROVIDER,
    UPSTREAM_BASE_URL: process.env.UPSTREAM_BASE_URL,
    UPSTREAM_API_KEY: process.env.UPSTREAM_API_KEY,
    GATEWAY_API_KEY: process.env.GATEWAY_API_KEY,
    GATEWAY_URL: process.env.GATEWAY_URL,
    LIVE_MODEL: process.env.LIVE_MODEL,
    CONTEXT_BUDGET: process.env.CONTEXT_BUDGET,
    MEMORY_AI_ENABLED: process.env.MEMORY_AI_ENABLED,
    MEMORY_AI_PROVIDER: process.env.MEMORY_AI_PROVIDER,
    MEMORY_AI_BASE_URL: process.env.MEMORY_AI_BASE_URL,
    MEMORY_AI_MODEL: process.env.MEMORY_AI_MODEL,
    MEMORY_AI_API_KEY: process.env.MEMORY_AI_API_KEY,
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    GROQ_BASE_URL: process.env.GROQ_BASE_URL,
    GROQ_EXTRACTION_MODEL: process.env.GROQ_EXTRACTION_MODEL,
    LOG_LEVEL: process.env.LOG_LEVEL,
  };

  // Only include defined values so the object stays serialisable/compact.
  for (const key of Object.keys(env) as (keyof Env)[]) {
    if (env[key] === undefined) {
      delete env[key];
    }
  }

  return env;
}
