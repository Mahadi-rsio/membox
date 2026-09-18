import { pgTable, varchar, text, timestamp, serial, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users.js";

export const messages = pgTable(
  "messages",
  {
    id: serial("id").primaryKey(),
    userId: varchar("user_id", { length: 128 })
      .notNull()
      .references(() => users.userId),
    messageKey: varchar("message_key", { length: 128 }).notNull(),
    role: varchar("role", { length: 32 }).notNull(),
    content: text("content").notNull(),
    contentHash: varchar("content_hash", { length: 64 }).notNull(),
    ordinal: integer("ordinal").notNull().default(0),
    clientMessageId: varchar("client_message_id", { length: 128 }),
    metadataJson: text("metadata_json"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .default(sql`now()`),
  },
  (table) => [
    index("idx_messages_user_id").on(table.userId),
    index("idx_messages_message_key").on(table.messageKey),
    uniqueIndex("uq_user_message_key").on(table.userId, table.messageKey),
  ]
);

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
