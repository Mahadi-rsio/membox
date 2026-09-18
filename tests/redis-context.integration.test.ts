import { describe, expect, it, beforeEach } from "bun:test";
import Redis from "ioredis";
import { createContextStoreFromRedis } from "../src/memory/context-store";
import type { ShortTermContextStore } from "../src/memory/context-store";
import { createTestDb } from "./helpers/db";
import type { Database } from "../src/db";
import { archiveRequest } from "../src/storage/archive";

const hasRedis = !!process.env.REDIS_URL;

function buildRedis(): ShortTermContextStore | null {
  if (!hasRedis) return null;
  return createContextStoreFromRedis(new Redis(process.env.REDIS_URL!));
}

describe("Live Redis context store", () => {
  let store: ShortTermContextStore;
  let db: Database;
  const uid = `redis-test-${Date.now()}`;

  beforeEach(async () => {
    db = await createTestDb();
    store = buildRedis()!;
  });

  it("requires live Redis credentials to run", () => {
    expect(hasRedis).toBeTruthy();
  });

  it("stores and reads a context value in real Redis", async () => {
    await store.setContext(uid, "current_task", "fixing auth", 3600);
    expect(await store.getContext(uid, "current_task")).toBe("fixing auth");
    await store.clearUser(uid);
  });

  it("lists live context entries and isolates per user", async () => {
    const uid2 = `${uid}-b`;
    await store.setContext(uid, "current_error", "401", 3600);
    await store.setContext(uid2, "current_error", "500", 3600);
    const all = await store.getAllContext(uid);
    expect(all.map((e) => e.key)).toContain("current_error");
    expect(String(all[0].value)).toBe("401");
    expect(String(await store.getContext(uid2, "current_error"))).toBe("500");
    await store.clearUser(uid);
    await store.clearUser(uid2);
  });

  it("deletes a single context key in real Redis", async () => {
    await store.setContext(uid, "current_task", "build", 3600);
    await store.deleteContext(uid, "current_task");
    expect(await store.getContext(uid, "current_task")).toBeNull();
    await store.clearUser(uid);
  });

  it("clears all context for a user in real Redis", async () => {
    await store.setContext(uid, "a", "1", 3600);
    await store.setContext(uid, "b", "2", 3600);
    await store.clearUser(uid);
    expect(await store.getAllContext(uid)).toHaveLength(0);
  });

  it("routes temporary context into real Redis via archiveRequest", async () => {
    await archiveRequest(
      db,
      { messages: [{ role: "user", content: "I'm currently debugging an auth bug" }] },
      { userId: uid, contextStore: store }
    );
    const entries = await store.getAllContext(uid);
    expect(entries.length).toBeGreaterThan(0);
    const joined = entries.map((e) => e.value.toLowerCase()).join(" ");
    expect(joined).toContain("debug");
    await store.clearUser(uid);
  });

  it("keeps durable facts out of Redis (stored to PostgreSQL instead)", async () => {
    await archiveRequest(
      db,
      { messages: [{ role: "user", content: "My name is Mahadi" }] },
      { userId: uid, contextStore: store }
    );
    expect(await store.getAllContext(uid)).toHaveLength(0);
    await store.clearUser(uid);
  });
});
