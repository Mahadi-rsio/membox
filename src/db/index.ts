import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";
import type { Env } from "../env";

export * from "./schema";

type AppDatabase = ReturnType<typeof drizzle<typeof schema>>;

let cached:
  | {
      url: string;
      db: AppDatabase;
      pool: Pool;
    }
  | null = null;

/**
 * Returns a Drizzle database backed by a `pg` connection pool.
 *
 * Works with PostgreSQL directly or through PgBouncer in transaction pooling
 * mode (session-level features are not used, so no risk of pooling issues).
 * A single pool is cached per `DATABASE_URL`.
 */
export function getDb(env: Env) {
  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not configured");
  }

  if (cached && cached.url === env.DATABASE_URL) {
    return cached.db;
  }

  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: Number(env.DATABASE_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  const db = drizzle(pool, { schema });
  cached = { url: env.DATABASE_URL, db, pool };
  return db;
}

export type Database = ReturnType<typeof getDb>;

/** Closes the cached pool (useful for graceful shutdown in tests/hot reload). */
export function closeDb() {
  if (cached?.pool) {
    cached.pool.end().catch(() => {});
    cached = null;
  }
}
