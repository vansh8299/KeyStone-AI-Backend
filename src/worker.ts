/**
 * Standalone ingestion worker: processes queued knowledge-base uploads without serving HTTP.
 * Run it as its own service (e.g. a Render Background Worker: `npm run build && npm run worker`)
 * and set INGESTION_WORKER=false on the API so parsing, OCR and embedding never compete with
 * requests. Uses the same environment variables as the API.
 */
import "./config/workerProcess"; // first: names this process "worker" in logs
import { env, envWarnings } from "./config/env";
import { prisma } from "./lib/prisma";
import { closeMongo } from "./lib/mongo";
import { closeRedis } from "./lib/redis";
import { drainBackground } from "./lib/backgroundTasks";
import { flushTraces } from "./lib/langsmith";
import { startIngestionWorker, stopIngestionWorker } from "./modules/rag/ingestionQueue";
import { moduleLogger } from "./lib/logger";

const log = moduleLogger("worker");
for (const warning of envWarnings) log.warn(warning);

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, "shutting down: finishing the jobs in progress");
  setTimeout(() => process.exit(1), env.shutdownGraceMs + 15_000).unref(); // last resort
  await stopIngestionWorker();
  // Jobs that can't finish in time keep their lease until it expires, then another worker retries them.
  const unfinished = await drainBackground(env.shutdownGraceMs);
  if (unfinished > 0) log.warn({ unfinished }, "stopping with jobs unfinished; they'll be retried");
  await Promise.allSettled([flushTraces(), prisma.$disconnect(), closeMongo(), closeRedis()]);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => log.error({ err: reason }, "unhandled promise rejection"));

startIngestionWorker(env.ingestionConcurrency).catch(async (err) => {
  log.fatal({ err }, "ingestion worker failed to start");
  await prisma.$disconnect();
  process.exit(1);
});
