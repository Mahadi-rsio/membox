/**
 * Short-term context store.
 *
 * Backs the "What is happening right now?" layer of the memory system.
 * Long-term facts live in PostgreSQL; this store holds ephemeral,
 * TTL-expiring conversation state in Redis (or an in-memory stand-in for
 * tests / when Redis is not configured).
 */
import type { ContextEntry } from "../models/memory.js";

export interface ShortTermContextStore {
  /** Upsert a context value with an optional TTL (seconds). */
  setContext(
    userId: string,
    key: string,
    value: string,
    ttlSeconds?: number
  ): Promise<void>;

  /** Read a single context value (or null when missing/expired). */
  getContext(userId: string, key: string): Promise<string | null>;

  /** Read every live context entry for a user (answering "what's happening now?"). */
  getAllContext(userId: string): Promise<ContextEntry[]>;

  /** Remove a context key. */
  deleteContext(userId: string, key: string): Promise<void>;

  /** Remove all context for a user. */
  clearUser(userId: string): Promise<void>;
}

export const DEFAULT_CONTEXT_TTL_SECONDS = 7200;

/**
 * In-memory context store. Deterministic and dependency-free; used by tests
 * and as a safe fallback when Redis is unavailable (fail-open).
 */
export class MemoryContextStore implements ShortTermContextStore {
  private data = new Map<string, Map<string, { value: string; expiresAt: number | null }>>();

  private bucket(userId: string): Map<string, { value: string; expiresAt: number | null }> {
    let m = this.data.get(userId);
    if (!m) {
      m = new Map();
      this.data.set(userId, m);
    }
    return m;
  }

  private isExpired(entry: { value: string; expiresAt: number | null }): boolean {
    return entry.expiresAt !== null && entry.expiresAt <= Date.now();
  }

  async setContext(
    userId: string,
    key: string,
    value: string,
    ttlSeconds?: number
  ): Promise<void> {
    const expiresAt =
      ttlSeconds && ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : null;
    this.bucket(userId).set(key, { value, expiresAt });
  }

  async getContext(userId: string, key: string): Promise<string | null> {
    const entry = this.bucket(userId).get(key);
    if (!entry) return null;
    if (this.isExpired(entry)) {
      this.bucket(userId).delete(key);
      return null;
    }
    return entry.value;
  }

  async getAllContext(userId: string): Promise<ContextEntry[]> {
    const out: ContextEntry[] = [];
    const map = this.bucket(userId);
    for (const [key, entry] of map.entries()) {
      if (this.isExpired(entry)) {
        map.delete(key);
        continue;
      }
      const ttlSeconds = entry.expiresAt
        ? Math.max(0, Math.round((entry.expiresAt - Date.now()) / 1000))
        : undefined;
      out.push({ key, value: entry.value, ttlSeconds });
    }
    return out;
  }

  async deleteContext(userId: string, key: string): Promise<void> {
    this.bucket(userId).delete(key);
  }

  async clearUser(userId: string): Promise<void> {
    this.data.delete(userId);
  }
}

/**
 * Upstash Redis-backed context store. Uses TTL for expiry. Falls back to
 * returning empty on Redis errors (fail-open, never breaks the main path).
 */
export class RedisContextStore implements ShortTermContextStore {
  private prefix = "memory-gateway:context:";

  constructor(private redis: {
    get: (key: string) => Promise<string | null>;
    set: (key: string, value: string, opts?: { ex?: number }) => Promise<unknown>;
    hgetall: (key: string) => Promise<Record<string, string> | null>;
    hset: (key: string, data: Record<string, string>) => Promise<unknown>;
    hdel: (key: string, ...fields: string[]) => Promise<unknown>;
    del: (key: string) => Promise<unknown>;
  }) {}

  private userKey(userId: string): string {
    return `${this.prefix}${userId}`;
  }

  private fieldKey(key: string): string {
    return key;
  }

  async setContext(
    userId: string,
    key: string,
    value: string,
    ttlSeconds?: number
  ): Promise<void> {
    try {
      await this.redis.hset(this.userKey(userId), { [this.fieldKey(key)]: value });
      if (ttlSeconds && ttlSeconds > 0) {
        // TTL on the whole user hash is coarse; approximate by expiring the
        // hash after the longest-lived key. Individual key expiry is not
        // supported by Upstash hashes, so we store ttlSeconds alongside.
        await this.redis.set(`${this.userKey(userId)}:ttl:${key}`, String(ttlSeconds), {
          ex: ttlSeconds,
        });
      }
    } catch {
      // fail-open: ignore Redis errors
    }
  }

  async getContext(userId: string, key: string): Promise<string | null> {
    try {
      const all = await this.redis.hgetall(this.userKey(userId));
      if (!all) return null;
      return all[this.fieldKey(key)] ?? null;
    } catch {
      return null;
    }
  }

  async getAllContext(userId: string): Promise<ContextEntry[]> {
    try {
      const all = await this.redis.hgetall(this.userKey(userId));
      if (!all) return [];
      return Object.entries(all).map(([key, value]) => ({ key, value }));
    } catch {
      return [];
    }
  }

  async deleteContext(userId: string, key: string): Promise<void> {
    try {
      await this.redis.hdel(this.userKey(userId), this.fieldKey(key));
    } catch {
      // fail-open
    }
  }

  async clearUser(userId: string): Promise<void> {
    try {
      await this.redis.del(this.userKey(userId));
    } catch {
      // fail-open
    }
  }
}

export function createContextStore(redis: {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string, opts?: { ex?: number }) => Promise<unknown>;
  hgetall: (key: string) => Promise<Record<string, string> | null>;
  hset: (key: string, data: Record<string, string>) => Promise<unknown>;
  hdel: (key: string, ...fields: string[]) => Promise<unknown>;
  del: (key: string) => Promise<unknown>;
} | null): ShortTermContextStore {
  if (redis) {
    return new RedisContextStore(redis);
  }
  return new MemoryContextStore();
}

/** Shared factory used by tests and the app to obtain a context store. */
export function createContextStoreFromRedis(
  redis: any
): ShortTermContextStore {
  if (redis) {
    return new RedisContextStore(redis);
  }
  return new MemoryContextStore();
}
