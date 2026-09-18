import { pgTable, varchar, text, timestamp, serial, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users.js";

export const contextVersions = pgTable(
  "context_versions",
  {
    id: serial("id").primaryKey(),
    userId: varchar("user_id", { length: 128 })
      .notNull()
      .references(() => users.userId),
    version: integer("version").notNull().default(1),
    stateJson: text("state_json").notNull().default("{}"),
    sourceMessageIdsJson: text("source_message_ids_json").notNull().default("[]"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .default(sql`now()`),
  },
  (table) => [
    index("idx_context_versions_user_id").on(table.userId),
    uniqueIndex("uq_user_context_version").on(table.userId, table.version),
  ]
);

export type ContextVersion = typeof contextVersions.$inferSelect;
export type NewContextVersion = typeof contextVersions.$inferInsert;
