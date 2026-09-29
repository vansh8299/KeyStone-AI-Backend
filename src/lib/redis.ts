import Redis from "ioredis";
import { env } from "../config/env";

/**
 * Shared state for running several backend instances: rate-limit counters, in-progress chat
 * replies and work locks. Everything that uses it falls back to this process's memory when
 * REDIS_URL isn't set, which is exactly right for a single instance.
 */
let client: Redis | null | undefined;
let subscriber: Redis | null = null;
const handlers = new Map<string, Set<(message: string) => void>>();
const subscribed = new Map<string, Promise<unknown>>();

function connect(): Redis {
  const redis = new Redis(env.redisUrl!, {
    // Fail commands quickly while disconnected so callers can fall back instead of hanging.
    maxRetriesPerRequest: 2,
    enableOfflineQueue: true,
  });
  redis.on("error", (err) => console.error("[redis]", err.message));
  return redis;
}

export function getRedis(): Redis | null {
  if (client === undefined) client = env.redisUrl ? connect() : null;
  return client;
}

/**
 * Subscribes to a pub/sub channel over one shared subscriber connection (a subscribed Redis
 * connection can't run other commands). Resolves once the subscription is active; the returned
 * function unsubscribes.
 */
export async function subscribe(channel: string, onMessage: (message: string) => void): Promise<() => Promise<void>> {
  if (!getRedis()) throw new Error("Redis is not configured");
  if (!subscriber) {
    subscriber = connect();
    subscriber.on("message", (ch: string, message: string) => handlers.get(ch)?.forEach((handle) => handle(message)));
  }
  let set = handlers.get(channel);
  if (!set) {
    set = new Set();
    handlers.set(channel, set);
    subscribed.set(channel, subscriber.subscribe(channel));
  }
  set.add(onMessage);
  await subscribed.get(channel);

  return async () => {
    const current = handlers.get(channel);
    if (!current) return;
    current.delete(onMessage);
    if (current.size === 0) {
      handlers.delete(channel);
      subscribed.delete(channel);
      await subscriber?.unsubscribe(channel).catch(() => {});
    }
  };
}

export async function closeRedis(): Promise<void> {
  await Promise.all([client?.quit().catch(() => {}), subscriber?.quit().catch(() => {})]);
  client = undefined;
  subscriber = null;
}
