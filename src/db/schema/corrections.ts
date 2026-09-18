import { pgTable, varchar, text, timestamp, serial, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users.js";

export const corrections = pgTable(
  "corrections",
  {
    id: serial("id").primaryKey(),
    userId: varchar("user_id", { length: 128 })
      .notNull()
      .references(() => users.userId),
    target: varchar("target", { length: 256 }).notNull().default(""),
    oldValue: varchar("old_value", { length: 1024 }).notNull().default(""),
    newValue: varchar("new_value", { length: 1024 }).notNull().default(""),
    status: varchar("status", { length: 32 }).notNull().default("active"),
    sourceMessageIdsJson: text("source_message_ids_json").notNull().default("[]"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .default(sql`now()`),
  },
  (table) => [
    index("idx_corrections_user_id").on(table.userId),
  ]
);

export type Correction = typeof corrections.$inferSelect;
export type NewCorrection = typeof corrections.$inferInsert;
