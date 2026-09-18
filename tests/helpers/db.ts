import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../../src/db/schema";
import type { Database as AppDatabase } from "../../src/db";
import { users } from "../../src/db/schema/users";
import { messages } from "../../src/db/schema/messages";
import { memoryItems } from "../../src/db/schema/memory";
import { contextVersions } from "../../src/db/schema/context";
import { corrections } from "../../src/db/schema/corrections";
import { MemoryContextStore } from "../../src/memory/context-store";

const TABLES = [users, messages, memoryItems, contextVersions, corrections];

const TABLE_NAME = Symbol.for("drizzle:Name");

function tableName(table: typeof users): string {
  return (table as any)[TABLE_NAME];
}

/**
 * Creates a connection to the PostgreSQL test database (DATABASE_URL), wrapped
 * in a Drizzle instance compatible with the memory engine. Each call truncates
 * all tables first so every test starts isolated. Requires a live PostgreSQL
 * test DB with the production schema already applied (see scripts/migrate.ts).
 */
export async function createTestDb(): Promise<AppDatabase> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is required to run integration tests. Point it at a PostgreSQL test database."
    );
  }

  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema }) as unknown as AppDatabase;

  for (const table of TABLES) {
    await db.execute(
      `TRUNCATE TABLE "${tableName(table)}" RESTART IDENTITY CASCADE`
    );
  }

  return db;
}

/**
 * Creates a fresh, isolated in-memory short-term context store for a test.
 */
export function createTestContextStore(): MemoryContextStore {
  return new MemoryContextStore();
}
