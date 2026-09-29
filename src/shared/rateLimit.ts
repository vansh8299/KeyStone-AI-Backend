import { getRedis } from "../lib/redis";
import { rateLimitedError } from "./errors";

interface Hit {
  count: number;
  resetInMs: number;
}

/**
 * Fixed-window rate limiter. Counts live in Redis when REDIS_URL is set, so every backend instance
 * shares them (with per-process counts, N instances would allow N× the attempts — including
 * password and OTP guesses). Without Redis, or if Redis is unreachable, it counts in memory.
 */
export function createRateLimiter({
  name,
  limit,
  windowMs,
  message,
}: {
  /** Unique per limiter; namespaces its keys in Redis. */
  name: string;
  limit: number;
  windowMs: number;
  message: string;
}) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.resetAt <= now) hits.delete(key);
  }, windowMs);
  sweep.unref();

  const redisKey = (key: string) => `ratelimit:${name}:${key}`;

  function hitMemory(key: string): Hit {
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count++;
    return { count: entry.count, resetInMs: entry.resetAt - now };
  }

  async function hit(key: string): Promise<Hit> {
    const redis = getRedis();
    if (!redis) return hitMemory(key);
    try {
      // Start the window only if it isn't running, then count — atomically, in one round trip.
      const results = await redis
        .multi()
        .set(redisKey(key), "0", "PX", windowMs, "NX")
        .incr(redisKey(key))
        .pttl(redisKey(key))
        .exec();
      const count = Number(results?.[1]?.[1]);
      const ttl = Number(results?.[2]?.[1]);
      if (!Number.isFinite(count)) throw new Error("unexpected MULTI reply");
      return { count, resetInMs: ttl > 0 ? ttl : windowMs };
    } catch (err) {
      console.error(`[rateLimit] Redis unavailable, counting in memory: ${(err as Error).message}`);
      return hitMemory(key);
    }
  }

  return {
    async consume(...keys: string[]) {
      for (const key of keys) {
        const { count, resetInMs } = await hit(key);
        if (count > limit) throw rateLimitedError(message, Math.ceil(resetInMs / 1000));
      }
    },
    async reset(key: string) {
      hits.delete(key);
      await getRedis()?.del(redisKey(key)).catch(() => {});
    },
  };
}
