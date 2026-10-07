import { moduleLogger } from "./logger";

const log = moduleLogger("browser");

const runningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;

/** Set once Chrome's sandbox has failed to start here (containers often forbid it), so later launches skip it. */
let sandboxUnavailable = runningAsRoot;

/**
 * Launches headless Chrome for rendering (HTML → PDF, reading web pages). Callers always disable
 * JavaScript and block network requests on their pages, which is what keeps untrusted content
 * contained; Chrome's own sandbox is an extra layer, used whenever the host allows it.
 */
export async function launchBrowser() {
  const { default: puppeteer } = await import("puppeteer");
  // Containers often give /dev/shm only 64 MB, which crashes Chrome on larger pages.
  const base = ["--disable-dev-shm-usage"];
  if (!sandboxUnavailable) {
    try {
      return await puppeteer.launch({ headless: true, args: base });
    } catch (err) {
      if (!/sandbox/i.test(String((err as Error)?.message))) throw err;
      sandboxUnavailable = true;
      log.warn("Chrome's sandbox isn't available on this host; rendering without it (scripts and network stay blocked)");
    }
  }
  return puppeteer.launch({ headless: true, args: [...base, "--no-sandbox", "--disable-setuid-sandbox"] });
}
