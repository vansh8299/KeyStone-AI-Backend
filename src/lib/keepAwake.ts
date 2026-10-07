import { moduleLogger } from "./logger";

const log = moduleLogger("keep-awake");

let timer: NodeJS.Timeout | null = null;

/**
 * Render's free web services spin down after 15 minutes without incoming requests. Requesting
 * our own public /health (and any other `urls`, e.g. the frontend) every `intervalMs` counts as
 * incoming traffic, so they stay up. /health doesn't touch the database, so a serverless database
 * can still suspend. A service that has already spun down can't wake itself, but this keeps it
 * from getting there.
 */
export function startKeepAwake(urls: string[], intervalMs: number): void {
  if (timer || intervalMs <= 0 || urls.length === 0) return;
  timer = setInterval(() => void Promise.all(urls.map(ping)), intervalMs);
  timer.unref(); // never keeps the process alive on its own
  log.info({ urls, intervalMs }, "keep-awake pings running");
}

async function ping(url: string) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(60_000), // a sleeping service can take ~50 s to wake
      headers: { "User-Agent": "keep-awake" },
      redirect: "manual",
    });
    // Any answer (even a redirect) means the service is up and the request counted.
    log.debug({ url, status: res.status, ms: Date.now() - started }, "keep-awake ping");
  } catch (err) {
    log.warn({ url, err: (err as Error)?.message, ms: Date.now() - started }, "keep-awake ping failed; will retry");
  }
}

export function stopKeepAwake(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
