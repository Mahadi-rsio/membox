#!/usr/bin/env bun
/**
 * Apply Drizzle SQL migrations to PostgreSQL.
 * Loads credentials from .env (local) or process.env.
 */
import { config } from "dotenv";
import { runMigrations } from "./automigrate";

config({ path: ".env" });

try {
  await runMigrations();
} catch (err: any) {
  console.error(err?.message ?? String(err));
  process.exit(1);
}
