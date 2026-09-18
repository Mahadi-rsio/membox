#!/usr/bin/env bun
/**
 * Apply Drizzle SQL migrations to Neon / PostgreSQL.
 * Loads credentials from .dev.vars (local) or process.env.
 */
import { config } from "dotenv";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { migrate } from "drizzle-orm/neon-http/migrator";

config({ path: ".env" });

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required (set in .dev.vars or env)");
  process.exit(1);
}

const sql = neon(url);
const db = drizzle(sql);

console.log(`Migrating Neon database ...`);
await migrate(db, { migrationsFolder: "./drizzle" });
console.log("Migrations applied.");
