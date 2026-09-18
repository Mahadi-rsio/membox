import { eq, and } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { users as usersTable } from "../db/schema/users.js";
import { messages as messagesTable, type Message } from "../db/schema/messages.js";
import { detectDelta, type DeltaResult } from "../memory/delta.js";
import { processMemoryDelta, processMemoryDeltaAsync } from "../memory/engine.js";
import type { ShortTermContextStore } from "../memory/context-store.js";
import type { ExtractionFallbackOptions } from "../memory/extractor.js";
import type { NormalizedMessage } from "../memory/ids.js";
import type { MemoryAIAdapter } from "../providers/memory-ai.js";

export function extractMessageList(body: Record<string, any>): Array<Record<string, any>> {
  const msgs = body.messages;
  if (Array.isArray(msgs)) {
    return msgs.filter((m) => typeof m === "object" && m !== null);
  }

  const rawInput = body.input;
  if (Array.isArray(rawInput)) {
    const out: Array<Record<string, any>> = [];
    for (const item of rawInput) {
      if (typeof item === "object" && item !== null) {
        out.push(item);
      } else if (typeof item === "string") {
        out.push({ role: "user", content: item });
      }
    }
    return out;
  }
  if (typeof rawInput === "string") {
    return [{ role: "user", content: rawInput }];
  }
  return [];
}

export async function ensureUser(
  db: Database,
  userId: string,
  apiKey: string | null
): Promise<void> {
  const existing = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.userId, userId))
    .limit(1);

  if (existing.length === 0) {
    await db.insert(usersTable).values({
      userId,
      apiKey: apiKey || "",
      createdAt: new Date().toISOString(),
    });
  }
}

export async function persistNewMessages(
  db: Database,
  userId: string,
  newMessages: NormalizedMessage[]
): Promise<Message[]> {
  const written: Message[] = [];
  const nowIso = new Date().toISOString();

  for (const msg of newMessages) {
    const existing = await db
      .select({ id: messagesTable.id })
      .from(messagesTable)
      .where(
        and(
          eq(messagesTable.userId, userId),
          eq(messagesTable.messageKey, msg.messageKey)
        )
      )
      .limit(1);

    if (existing.length > 0) {
      continue;
    }

    const [row] = await db
      .insert(messagesTable)
      .values({
        userId,
        messageKey: msg.messageKey,
        role: msg.role,
        content: msg.content,
        contentHash: msg.contentHash,
        ordinal: msg.ordinal,
        clientMessageId: msg.clientMessageId,
        metadataJson: JSON.stringify(msg.raw),
        createdAt: nowIso,
      })
      .returning();

    written.push(row);
  }

  return written;
}

export async function archiveRequest(
  db: Database,
  body: Record<string, any>,
  options?: {
    userId: string;
    apiKey?: string | null;
    headers?: Headers | Record<string, string>;
    contextStore?: ShortTermContextStore | null;
    groq?: ExtractionFallbackOptions | null;
  }
): Promise<DeltaResult | null> {
  try {
    const userId = options?.userId || "";
    const messages = extractMessageList(body);
    await ensureUser(db, userId, options?.apiKey ?? null);

    const delta = await detectDelta(db, userId, null, messages);
    if (delta.newMessages.length > 0) {
      await persistNewMessages(db, userId, delta.newMessages);
    }

    // Run extraction even when every message is a duplicate: the message may
    // have been archived before its facts were extracted (older extractor,
    // outage). Store-level dedup keeps re-extraction idempotent.
    if (delta.allMessages.length > 0) {
      try {
        await processMemoryDelta(db, delta, {
          contextStore: options?.contextStore,
          groq: options?.groq ?? null,
        });
      } catch {}
    }

    return delta;
  } catch {
    return null;
  }
}

export async function archiveRequestAsync(
  db: Database,
  body: Record<string, any>,
  options?: {
    userId: string;
    apiKey?: string | null;
    headers?: Headers | Record<string, string>;
    memoryAi?: MemoryAIAdapter | null;
    contextStore?: ShortTermContextStore | null;
    groq?: ExtractionFallbackOptions | null;
  }
): Promise<DeltaResult | null> {
  try {
    const userId = options?.userId || "";
    const messages = extractMessageList(body);
    await ensureUser(db, userId, options?.apiKey ?? null);

    const delta = await detectDelta(db, userId, null, messages);
    if (delta.newMessages.length > 0) {
      await persistNewMessages(db, userId, delta.newMessages);
    }

    // Run extraction even when every message is a duplicate: the message may
    // have been archived before its facts were extracted (older extractor,
    // outage). Store-level dedup keeps re-extraction idempotent.
    if (delta.allMessages.length > 0) {
      try {
        await processMemoryDeltaAsync(db, delta, {
          memoryAi: options?.memoryAi,
          contextStore: options?.contextStore,
          groq: options?.groq ?? null,
        });
      } catch {}
    }

    return delta;
  } catch {
    return null;
  }
}

export async function listArchivedKeys(
  db: Database,
  userId: string
): Promise<Set<string>> {
  const rows = await db
    .select({ messageKey: messagesTable.messageKey })
    .from(messagesTable)
    .where(eq(messagesTable.userId, userId));

  return new Set(rows.map((r) => r.messageKey));
}
