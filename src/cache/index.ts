import { Redis } from "@upstash/redis";
import { Ratelimit } from "@upstash/ratelimit";
import type { Env } from "../env";

/**
 * Returns an Upstash Redis client instance if credentials are provided in Env.
 */
export function getRedis(env: Env): Redis | null {
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) {
    return null;
  }

  return new Redis({
    url: env.UPSTASH_REDIS_REST_URL,
    token: env.UPSTASH_REDIS_REST_TOKEN,
  });
}

/**
 * Returns an Upstash RateLimiter instance if Redis is configured.
 */
export function getRateLimiter(
  env: Env,
  requests = 60,
  window: "10 s" | "1 m" | "1 h" = "1 m"
): Ratelimit | null {
  const redis = getRedis(env);
  if (!redis) return null;

  return new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(requests, window),
    prefix: "memory-gateway:ratelimit",
  });
}
