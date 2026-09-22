import type { AgentStatus } from "./langchain/agent";
import type { AgentStreamEvent } from "./agentChat.service";

const FINISHED_TTL_MS = 60_000;

type Listener = (event: AgentStreamEvent | { type: "FAILED"; error: unknown }) => void;

export class ActiveTurn {
  private text = "";
  private status: AgentStatus | null = null;
  private outcome: { done: AgentStreamEvent & { type: "DONE" } } | { error: unknown } | null = null;
  private listeners = new Set<Listener>();

  constructor(readonly userId: string) {}

  publish(event: AgentStreamEvent) {
    if (event.type === "TOKEN") this.text += event.text;
    else if (event.type === "STATUS") this.status = event.status;
    else if (event.type === "DONE") this.outcome = { done: event };
    this.listeners.forEach((listener) => listener(event));
  }

  fail(error: unknown) {
    this.outcome = { error };
    this.listeners.forEach((listener) => listener({ type: "FAILED", error }));
  }

  events(): AsyncGenerator<AgentStreamEvent> {
    const queue: (AgentStreamEvent | { type: "FAILED"; error: unknown })[] = [];
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

const byConversation = new Map<string, ActiveTurn>();

export const activeTurns = {
  register(conversationId: string, turn: ActiveTurn) {
    byConversation.set(conversationId, turn);
  },

  release(conversationId: string, turn: ActiveTurn) {
    setTimeout(() => {
      if (byConversation.get(conversationId) === turn) byConversation.delete(conversationId);
    }, FINISHED_TTL_MS).unref();
  },

  find(conversationId: string, userId: string): ActiveTurn | null {
    const turn = byConversation.get(conversationId);
    return turn && turn.userId === userId ? turn : null;
  },
};
