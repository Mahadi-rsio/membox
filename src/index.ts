import express from "express";
import type { Express } from "express";
import cors from "cors";
import { getEnv, type Env } from "./env";
import { configureLogLevel } from "./log";
import { healthRouter } from "./routes/health";
import { v1Router } from "./routes/v1";
import { memoryRouter } from "./routes/memory";
import { chatRouter } from "./routes/chat";

export function createApp(env: Env = getEnv()): Express {
  const app = express();

  // Store the runtime env on the app so any handler can read it via getEnv().
  app.locals.env = env;

  // Middleware
  app.use((req, res, next) => {
    configureLogLevel(env.LOG_LEVEL);
    next();
  });
  app.use(cors());
  app.use(express.json());

  // Health checks
  app.use("/", healthRouter);
  app.use("/v1", healthRouter);

  // V1 OpenAI-compatible routes
  app.use("/v1", v1Router);

  // V1 memory routes (MCP → Gateway every-message path)
  app.use("/v1", memoryRouter);

  // Web UI chat endpoint (latest-message only → gateway memory pipeline)
  app.use("/", chatRouter);

  // Root route
  app.get("/", (req, res) => {
    res.json({
      name: "remember-memory-gateway",
      description: "OpenAI-compatible AI Memory Gateway",
      runtime: "Node.js",
      framework: "Express",
      orm: "Drizzle",
      database: "PostgreSQL (self-hosted)",
      cache: "Redis (self-hosted)",
      version: "0.1.0",
      endpoints: {
        health: "/health",
        v1_models: "/v1/models",
        v1_chat_completions: "/v1/chat/completions",
        v1_responses: "/v1/responses",
      },
    });
  });

  // Convert malformed JSON bodies into the OpenAI-style 400 error so the
  // gateway's error contract is preserved after `express.json()`.
  app.use(
    (err: any, req: any, res: any, next: any) => {
      if (err && err.type === "entity.parse.failed") {
        return res.status(400).json({
          error: {
            message: "Request body must be valid JSON",
            type: "invalid_request_error",
            code: "invalid_json",
          },
        });
      }
      return next(err);
    }
  );

  return app;
}

// Boot the server when this module is run directly (not imported by tests).
const entryPath = process.argv[1];
const isDirectRun =
  !!entryPath &&
  (import.meta.url === new URL(`file://${entryPath}`).href ||
    import.meta.url.endsWith(entryPath.split(/[\\/]/).pop() ?? "index.ts"));

if (isDirectRun) {
  // Load a local .env if present (non-secret config), secrets come from env.
  try {
    const { config } = await import("dotenv");
    config();
  } catch {
    /* dotenv optional */
  }

  const app = createApp();
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || "127.0.0.1";

  // Apply database migrations on boot unless explicitly disabled. Safe to run
  // every start (Drizzle skips already-applied migrations). In Docker,
  // MIGRATION_DATABASE_URL points directly at Postgres so DDL avoids the
  // PgBouncer transaction-pooling limitation.
  if (String(process.env.AUTO_MIGRATE ?? "true").toLowerCase() !== "false") {
    try {
      const { runMigrations } = await import("../scripts/automigrate");
      await runMigrations();
    } catch (err: any) {
      console.error("Auto-migration failed:", err?.message ?? String(err));
    }
  }

  app.listen(port, host, () => {
    console.log(`\n  Remember Memory Gateway running at http://${host}:${port}`);
    console.log(`  Upstream: ${getEnv().UPSTREAM_BASE_URL || "https://api.openai.com/v1"}\n`);
  });
}
