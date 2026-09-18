import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

/**
 * Apply Drizzle SQL migrations to PostgreSQL.
 *
 * Prefers MIGRATION_DATABASE_URL (used in Docker where the gateway connects to
 * Postgres through PgBouncer transaction pooling, which cannot run DDL). Falls
 * back to DATABASE_URL for local/single-endpoint setups.
 *
 * Safe to call on every boot: Drizzle tracks applied migrations and skips any
 * that have already run.
 */
export async function runMigrations(): Promise<void> {
  const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required (set in .env or env)");
  }

  const pool = new Pool({
    connectionString: url,
    connectionTimeoutMillis: 10_000,
    max: 2,
  });
  const db = drizzle(pool);

  console.log("Applying database migrations ...");
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("Migrations applied.");

  await pool.end();
}
