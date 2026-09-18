import { Redis } from "ioredis";
import type { Env } from "../env.js";

let cachedRedis:
  | {
      url: string;
      client: Redis;
    }
  | null = null;

/**
 * Returns a shared ioredis client instance if a REDIS_URL is configured.
 * The client is cached per REDIS_URL so connections are not re-created on
 * every request. Connects to a self-hosted Redis server (or any
 * Redis-compatible endpoint).
 */
export function getRedis(env: Env): Redis | null {
  const url = env.REDIS_URL;
  if (!url) {
    return null;
  }

  if (cachedRedis && cachedRedis.url === url) {
    return cachedRedis.client;
  }

  const client = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 5_000,
  });

  cachedRedis = { url, client };
  return client;
}

/** Closes the cached Redis client (graceful shutdown). */
export function closeRedis() {
  if (cachedRedis) {
    cachedRedis.client.disconnect();
    cachedRedis = null;
  }
}

export interface RateLimitResult {
  success: boolean;
  remaining: number;
  limit: number;
  reset: number;
}

/**
 * A small sliding-window rate limiter implemented over ioredis.
 * Replaces the previous Upstash Ratelimit dependency.
 *
 * Returns `null` when Redis is not configured (rate limiting disabled).
 */
export async function checkRateLimit(
  redis: Redis,
  key: string,
  requests: number,
  windowSeconds: number
): Promise<RateLimitResult> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - windowSeconds;
  const member = `${now}:${Math.random().toString(36).slice(2)}`;

  const script = `
    local key = KEYS[1]
    local now = tonumber(ARGV[1])
    local windowStart = tonumber(ARGV[2])
    local member = ARGV[3]
    local limit = tonumber(ARGV[4])

    redis.call('ZREMRANGEBYSCORE', key, '-inf', windowStart)
    local count = redis.call('ZCARD', key)
    if count >= limit then
      return 0
    end
    redis.call('ZADD', key, now, member)
    redis.call('EXPIRE', key, windowStart + windowSeconds * 2)
    return 1
  `;

  const allowed = await redis.eval(
    script,
    1,
    `memory-gateway:ratelimit:${key}`,
    String(now),
    String(windowStart),
    member,
    String(requests)
  );

  return {
    success: allowed === 1,
    remaining: Math.max(0, requests - (await redis.zcard(`memory-gateway:ratelimit:${key}`))),
    limit: requests,
    reset: now + windowSeconds,
  };
}

/**
 * Returns a rate-limit check bound to the configured Redis, or null if Redis
 * is not configured (rate limiting disabled).
 */
export function getRateLimiter(env: Env, requests = 60, windowSeconds = 60) {
  const redis = getRedis(env);
  if (!redis) return null;
  return {
    redis,
    check: (key: string) => checkRateLimit(redis, key, requests, windowSeconds),
  };
}
