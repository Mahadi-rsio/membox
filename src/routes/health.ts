import { Router } from "express";
import { getDb } from "../db/index.js";
import { getRedis } from "../cache/index.js";
import { getEnv } from "../http.js";
import { sql } from "drizzle-orm";

export const healthRouter = Router();

healthRouter.get("/health", async (req, res) => {
  const env = getEnv(req);
  let dbReady = false;
  let redisReady = false;

  if (env.DATABASE_URL) {
    try {
      const db = getDb(env);
      await db.execute(sql`SELECT 1`);
      dbReady = true;
    } catch {
      dbReady = false;
    }
  }

  // Redis check (optional)
  const redis = getRedis(env);
  if (redis) {
    try {
      const pong = await redis.ping();
      redisReady = pong === "PONG";
    } catch {
      redisReady = false;
    }
  }

  const isMemoryAiEnabled =
    String(env.MEMORY_AI_ENABLED).toLowerCase() === "true";

  // Fail-open when Postgres is not configured (proxy still works without memory)
  const ready = dbReady || !env.DATABASE_URL;

  res.json({
    status: ready ? "ok" : "degraded",
    service: "remember-memory-gateway",
    runtime: "node",
    database: {
      provider: "postgres",
      ready: dbReady,
    },
    cache: {
      provider: "redis",
      configured: Boolean(redis),
      ready: redisReady,
    },
    memory_ai_enabled: isMemoryAiEnabled,
    context_budget: Number(env.CONTEXT_BUDGET ?? 8000),
  });
});
