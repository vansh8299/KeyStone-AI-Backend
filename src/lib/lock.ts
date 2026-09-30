import { randomUUID } from "crypto";
import { getRedis } from "./redis";
import { moduleLogger } from "./logger";

const log = moduleLogger("lock");

const held = new Set<string>();

/**
 * A best-effort "only one at a time" lock for background work. With Redis it holds across every
 * backend instance (expiring after ttlMs in case the holder dies); without Redis, or if Redis is
 * unreachable, it holds within this process. Returns a release function, or null if already held.
 */
export async function tryLock(name: string, ttlMs: number): Promise<(() => Promise<void>) | null> {
  if (held.has(name)) return null;
  held.add(name);
  const releaseLocal = () => {
    held.delete(name);
  };

  const redis = getRedis();
  if (!redis) return async () => releaseLocal();

  const key = `lock:${name}`;
  const token = randomUUID();
  try {
    const acquired = await redis.set(key, token, "PX", ttlMs, "NX");
    if (!acquired) {
      releaseLocal();
      return null;
    }
  } catch (err) {
    log.warn({ err, lock: name }, "Redis unavailable; locking in this process only");
    return async () => releaseLocal();
  }

  return async () => {
    releaseLocal();
    try {
      // Only delete the lock if it's still ours (it may have expired and been taken by another instance).
      if ((await redis.get(key)) === token) await redis.del(key);
    } catch {
      // It expires on its own.
    }
  };
}
