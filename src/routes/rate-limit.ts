import type { Request, Response } from "../http.js";
import { getEnv } from "../http.js";
import { getRateLimiter } from "../cache/index.js";

export async function checkRateLimit(req: Request, res: Response): Promise<Response | null> {
  const env = getEnv(req);
  const limiter = getRateLimiter(env);
  if (!limiter) {
    return null; // Rate limiting not active without Redis
  }

  const ip =
    req.header("cf-connecting-ip") ||
    req.header("x-forwarded-for")?.split(",")[0].trim() ||
    "unknown";

  try {
    const { success, reset } = await limiter.check(ip);
    if (!success) {
      const retryAfterSeconds = Math.max(1, Math.ceil(reset - Date.now() / 1000));
      return res.status(429).set("Retry-After", String(retryAfterSeconds)).json({
        error: {
          message: "Rate limit exceeded; please retry later",
          type: "requests",
          code: "rate_limit_exceeded",
        },
      });
    }
  } catch {
    // Fail open on rate limiter error
    return null;
  }

  return null;
}
