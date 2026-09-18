import { pgTable, varchar, text, timestamp, serial, integer, real, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users.js";

export const memoryItems = pgTable(
  "memory_items",
  {
    id: serial("id").primaryKey(),
    userId: varchar("user_id", { length: 128 })
      .notNull()
      .references(() => users.userId),
    content: text("content").notNull(),
    type: varchar("type", { length: 64 }).notNull(),
    topicKey: varchar("topic_key", { length: 128 }).notNull().default(""),
    subject: varchar("subject", { length: 256 }).notNull().default(""),
    predicate: varchar("predicate", { length: 256 }).notNull().default(""),
    value: text("value").notNull().default(""),
    scope: varchar("scope", { length: 32 }).notNull().default("project"),
    confidence: real("confidence").notNull().default(0.0),
    importance: real("importance").notNull().default(0.0),
    stability: real("stability").notNull().default(0.0),
    freshness: real("freshness").notNull().default(0.0),
    informationGain: real("information_gain").notNull().default(0.0),
    sourceMessageIdsJson: text("source_message_ids_json").notNull().default("[]"),
    /** Relationship links to other memory items (ids serialized as JSON array). */
    supersedesId: integer("supersedes_id"),
    contradictsIdsJson: text("contradicts_ids_json").notNull().default("[]"),
    relatedMemoryIdsJson: text("related_memory_ids_json").notNull().default("[]"),
    /** The relationship this item has with its `supersedesId` target. */
    relationship: varchar("relationship", { length: 32 }),
    status: varchar("status", { length: 32 }).notNull().default("active"),
    version: integer("version").notNull().default(1),
    validFrom: timestamp("valid_from", { withTimezone: true, mode: "string" }),
    validUntil: timestamp("valid_until", { withTimezone: true, mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .notNull()
      .default(sql`now()`),
  },
  (table) => [
    index("idx_memory_items_user_id").on(table.userId),
    index("idx_memory_items_type").on(table.type),
    index("idx_memory_items_topic_key").on(table.topicKey),
    index("idx_memory_items_status").on(table.status),
    index("idx_memory_items_subject").on(table.subject),
    index("idx_memory_items_predicate").on(table.predicate),
    index("idx_memory_items_scope").on(table.scope),
    index("idx_memory_items_supersedes_id").on(table.supersedesId),
  ]
);

export type MemoryItem = typeof memoryItems.$inferSelect;
export type NewMemoryItem = typeof memoryItems.$inferInsert;
