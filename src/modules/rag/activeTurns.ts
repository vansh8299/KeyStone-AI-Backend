import { GraphQLError } from "graphql";
import type { AgentStatus } from "./langchain/agent";
import type { AgentStreamEvent } from "./agentChat.service";
import { getRedis, subscribe } from "../../lib/redis";
import { isExposedCode } from "../../shared/errors";
import { moduleLogger } from "../../lib/logger";

const log = moduleLogger("active-turns");

const FINISHED_TTL_MS = 60_000;
/** A running reply's shared record expires if it stops being updated (e.g. its instance crashed). */
const RUNNING_TTL_MS = 10 * 60_000;
/** How often a remote listener that has heard nothing checks the reply still exists. */
const REMOTE_IDLE_CHECK_MS = 30_000;

type Failure = { type: "FAILED"; error: unknown };
type Listener = (event: AgentStreamEvent | Failure) => void;
type SerializedError = { message: string; code?: string };
type RelayedEvent = (AgentStreamEvent | { type: "FAILED"; error: SerializedError }) & { seq: number };

const keys = (conversationId: string) => ({
  state: `turn:${conversationId}`,
  text: `turn:${conversationId}:text`,
  channel: `turn:${conversationId}:events`,
});

/** Errors cross instances as data; only codes that are safe to show keep their message. */
function serializeError(error: unknown): SerializedError {
  const code = error instanceof GraphQLError ? error.extensions?.code : undefined;
  return isExposedCode(code) ? { message: (error as GraphQLError).message, code } : { message: "Chat reply failed" };
}

function deserializeError({ message, code }: SerializedError): Error {
  return code ? new GraphQLError(message, { extensions: { code } }) : new Error(message);
}

/**
 * Mirrors a running reply into Redis — text so far, status and outcome, plus a pub/sub event per
 * update — so a client that reconnects to another backend instance can pick it up. Writes are
 * chained to keep them in order; a Redis hiccup only affects reconnects elsewhere, never the reply.
 */
class TurnRelay {
  private chain: Promise<unknown>;
  private readonly k: ReturnType<typeof keys>;

  constructor(conversationId: string, userId: string) {
    this.k = keys(conversationId);
    const redis = getRedis()!;
    this.chain = redis
      .multi()
      .del(this.k.state, this.k.text)
      .hset(this.k.state, { userId, seq: 0 })
      .pexpire(this.k.state, RUNNING_TTL_MS)
      .exec()
      .catch((err) => log.warn({ err }, "sharing a reply via Redis failed to start"));
  }

  push(event: AgentStreamEvent | Failure) {
    if (event.type === "CONVERSATION") return; // reconnecting clients get this from attach()
    this.chain = this.chain
      .then(async () => {
        const redis = getRedis()!;
        const finished = event.type === "DONE" || event.type === "FAILED";
        const multi = redis.multi();
        if (event.type === "TOKEN") multi.append(this.k.text, event.text);
        if (event.type === "RESET") multi.del(this.k.text);
        if (event.type === "STATUS") multi.hset(this.k.state, "status", event.status);
        if (event.type === "DONE") multi.hset(this.k.state, "outcome", JSON.stringify({ done: event }));
        if (event.type === "FAILED") multi.hset(this.k.state, "outcome", JSON.stringify({ error: serializeError(event.error) }));
        multi.hincrby(this.k.state, "seq", 1);
        const ttl = finished ? FINISHED_TTL_MS : RUNNING_TTL_MS;
        multi.pexpire(this.k.state, ttl).pexpire(this.k.text, ttl);
        const results = await multi.exec();
        // Each event writes exactly one field first, so HINCRBY's reply is the second result.
        const seq = Number(results?.[1]?.[1]);
        const relayed: RelayedEvent =
          event.type === "FAILED" ? { type: "FAILED", error: serializeError(event.error), seq } : { ...event, seq };
        await redis.publish(this.k.channel, JSON.stringify(relayed));
      })
      .catch((err) => log.warn({ err }, "sharing a reply update via Redis failed"));
  }
}

export class ActiveTurn {
  private text = "";
  private status: AgentStatus | null = null;
  private outcome: { done: AgentStreamEvent & { type: "DONE" } } | { error: unknown } | null = null;
  private listeners = new Set<Listener>();
  private relay: TurnRelay | null = null;

  constructor(readonly userId: string) {}

  /** Starts sharing this reply with other instances (only when Redis is configured). */
  shareAs(conversationId: string) {
    if (getRedis()) this.relay = new TurnRelay(conversationId, this.userId);
  }

  publish(event: AgentStreamEvent) {
    if (event.type === "TOKEN") this.text += event.text;
    else if (event.type === "RESET") this.text = "";
    else if (event.type === "STATUS") this.status = event.status;
    else if (event.type === "DONE") this.outcome = { done: event };
    this.relay?.push(event);
    this.listeners.forEach((listener) => listener(event));
  }

  fail(error: unknown) {
    this.outcome = { error };
    this.relay?.push({ type: "FAILED", error });
    this.listeners.forEach((listener) => listener({ type: "FAILED", error }));
  }

  events(): AsyncGenerator<AgentStreamEvent> {
    const queue: (AgentStreamEvent | Failure)[] = [];
    let wake: (() => void) | null = null;
    const listener: Listener = (event) => {
      queue.push(event);
      wake?.();
      wake = null;
    };

    if (this.text) queue.push({ type: "TOKEN", text: this.text });
    else if (this.status) queue.push({ type: "STATUS", status: this.status });
    if (this.outcome) queue.push("done" in this.outcome ? this.outcome.done : { type: "FAILED", error: this.outcome.error });
    else this.listeners.add(listener);

    const listeners = this.listeners;
    return (async function* () {
      try {
        while (true) {
          const event = queue.shift();
          if (!event) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
            continue;
          }
          if (event.type === "FAILED") throw event.error;
          yield event;
          if (event.type === "DONE") return;
        }
      } finally {
        listeners.delete(listener);
      }
    })();
  }
}

/**
 * Follows a reply running on another instance: subscribes first, then reads the saved progress,
 * and skips relayed events already included in it (by sequence number), so nothing is lost or
 * repeated in between. Returns null when there's no such reply for this user.
 */
async function followRemote(conversationId: string, userId: string): Promise<AsyncGenerator<AgentStreamEvent> | null> {
  const redis = getRedis();
  if (!redis) return null;
  const k = keys(conversationId);

  const queue: RelayedEvent[] = [];
  let wake: (() => void) | null = null;
  const unsubscribe = await subscribe(k.channel, (message) => {
    try {
      queue.push(JSON.parse(message) as RelayedEvent);
    } catch {
      return;
    }
    wake?.();
    wake = null;
  });

  let state: Record<string, string>;
  let text: string | null;
  try {
    [state, text] = await Promise.all([redis.hgetall(k.state), redis.get(k.text)]);
  } catch (err) {
    await unsubscribe();
    throw err;
  }
  if (state.userId !== userId) {
    await unsubscribe();
    return null;
  }
  const savedSeq = Number(state.seq) || 0;

  return (async function* () {
    try {
      if (text) yield { type: "TOKEN", text };
      else if (state.status) yield { type: "STATUS", status: state.status as AgentStatus };
      if (state.outcome) {
        const outcome = JSON.parse(state.outcome) as { done: AgentStreamEvent } | { error: SerializedError };
        if (!("done" in outcome)) throw deserializeError(outcome.error);
        yield outcome.done;
        return;
      }

      while (true) {
        const next = queue.shift();
        if (!next) {
          const heard = await new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => resolve(false), REMOTE_IDLE_CHECK_MS);
            wake = () => {
              clearTimeout(timer);
              resolve(true);
            };
          });
          // Nothing for a while: stop if the reply's record is gone (its instance died).
          if (!heard && !(await redis.exists(k.state))) return;
          continue;
        }
        if (next.seq <= savedSeq) continue;
        const { seq: _seq, ...event } = next;
        if (event.type === "FAILED") throw deserializeError(event.error);
        yield event as AgentStreamEvent;
        if (event.type === "DONE") return;
      }
    } finally {
      await unsubscribe();
    }
  })();
}

const byConversation = new Map<string, ActiveTurn>();

export const activeTurns = {
  register(conversationId: string, turn: ActiveTurn) {
    byConversation.set(conversationId, turn);
    turn.shareAs(conversationId);
  },

  release(conversationId: string, turn: ActiveTurn) {
    setTimeout(() => {
      if (byConversation.get(conversationId) === turn) byConversation.delete(conversationId);
    }, FINISHED_TTL_MS).unref();
  },

  /** The reply's events from here on, whether it runs on this instance or another; null if none. */
  async follow(conversationId: string, userId: string): Promise<AsyncGenerator<AgentStreamEvent> | null> {
    const local = byConversation.get(conversationId);
    if (local) return local.userId === userId ? local.events() : null;
    return followRemote(conversationId, userId);
  },
};
