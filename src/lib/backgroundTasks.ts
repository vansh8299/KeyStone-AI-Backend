import { moduleLogger } from "./logger";

const log = moduleLogger("background");

/**
 * Work that runs after a response has been sent — chat replies still generating, memory summaries,
 * feedback sync, cleanups. Tracked so a deploy or scale-down (SIGTERM) can let it finish instead of
 * cutting it off, and so a failure is always logged instead of becoming an unhandled rejection.
 */
const running = new Set<Promise<unknown>>();

/** Tracks work that's already running (e.g. a chat reply whose events are streamed elsewhere). */
export function trackBackground(work: Promise<unknown>): void {
  running.add(work);
  work.catch(() => {}).finally(() => running.delete(work));
}

/** Starts a task without waiting for it; errors are logged under `name`. */
export function runInBackground(name: string, task: () => Promise<unknown>): void {
  trackBackground(
    Promise.resolve()
      .then(task)
      .catch((err) => log.error({ err, task: name }, "background task failed"))
  );
}

/**
 * Waits for background work to finish, up to timeoutMs — including tasks started while waiting
 * (a reply that finishes kicks off its memory summary). Returns how many were still running.
 */
export async function drainBackground(timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (running.size > 0 && Date.now() < deadline) {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled([...running]),
      new Promise((resolve) => {
        timer = setTimeout(resolve, deadline - Date.now());
      }),
    ]);
    clearTimeout(timer);
  }
  return running.size;
}
