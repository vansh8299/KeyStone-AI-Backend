import { rateLimitedError } from "./errors";

export function createRateLimiter({ limit, windowMs, message }: { limit: number; windowMs: number; message: string }) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.resetAt <= now) hits.delete(key);
  }, windowMs);
  sweep.unref();

  return {
    consume(...keys: string[]) {
      const now = Date.now();
      for (const key of keys) {
        let entry = hits.get(key);
        if (!entry || entry.resetAt <= now) {
          entry = { count: 0, resetAt: now + windowMs };
          hits.set(key, entry);
        }
        entry.count++;
        if (entry.count > limit) {
          throw rateLimitedError(message, Math.ceil((entry.resetAt - now) / 1000));
        }
      }
    },
    reset(key: string) {
      hits.delete(key);
    },
  };
}
