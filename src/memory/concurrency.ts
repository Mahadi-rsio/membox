/**
 * Optimistic concurrency control for memory items.
 *
 * Prevents simultaneous requests from silently overwriting each other's memory
 * updates. Each `memory_items` row carries a monotonically increasing `version`.
 * Updates are expressed as compare-and-swap (CAS):
 *
 *   read version
 *   → UPDATE ... WHERE id = ? AND version = expectedVersion  (version += 1)
 *   → success: increment version
 *   → conflict: zero rows changed → reload + merge + retry
 *
 * `updateItemAtomic` returns `true` only when the CAS update affected exactly
 * one row, i.e. no concurrent writer modified the item in the meantime.
 */
import { eq, and } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { memoryItems, type MemoryItem } from "../db/schema/memory.js";

export async function updateItemAtomic(
  db: Database,
  id: number,
  expectedVersion: number,
  patch: Partial<MemoryItem>
): Promise<boolean> {
  const [row] = await db
    .update(memoryItems)
    .set({ ...patch, version: expectedVersion + 1 })
    .where(
      and(
        eq(memoryItems.id, id),
        eq(memoryItems.version, expectedVersion)
      )
    )
    .returning({ id: memoryItems.id });
  return row !== undefined;
}
