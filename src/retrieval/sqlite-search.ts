import { eq, and, like } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { messages } from "../db/schema/messages.js";
import { memoryItems } from "../db/schema/memory.js";
import { MemoryStatus } from "../models/memory.js";
import type { Retriever, RetrievalResult } from "./interface.js";

/** SQLite/libSQL LIKE-based retriever (portable across Turso and local SQLite). */
export class SqliteRetriever implements Retriever {
  constructor(private db: Database) {}

  async searchMessages(
    query: string,
    userId: string,
    limit = 10
  ): Promise<RetrievalResult[]> {
    if (!query.trim()) return [];
    try {
      const pattern = `%${query.trim()}%`;
      const rows = await this.db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.userId, userId),
            like(messages.content, pattern)
          )
        )
        .limit(limit);

      return rows.map((r) => ({
        source: "messages" as const,
        rowId: r.id,
        content: r.content,
        role: r.role,
        userId: r.userId,
        score: 1.0,
      }));
    } catch {
      return [];
    }
  }

  async searchMemory(
    query: string,
    userId: string,
    limit = 10
  ): Promise<RetrievalResult[]> {
    if (!query.trim()) return [];
    try {
      const pattern = `%${query.trim()}%`;
      const rows = await this.db
        .select()
        .from(memoryItems)
        .where(
          and(
            eq(memoryItems.userId, userId),
            eq(memoryItems.status, MemoryStatus.ACTIVE),
            like(memoryItems.content, pattern)
          )
        )
        .limit(limit);

      return rows.map((r) => ({
        source: "memory_items" as const,
        rowId: r.id,
        content: r.content,
        itemType: r.type,
        topicKey: r.topicKey,
        userId: r.userId,
        score: 1.0,
      }));
    } catch {
      return [];
    }
  }
}

/** @deprecated Use SqliteRetriever */
export const D1Retriever = SqliteRetriever;
