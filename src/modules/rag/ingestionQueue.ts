import { prisma } from "../../lib/prisma";
import { getRedis, subscribe } from "../../lib/redis";
import { trackBackground } from "../../lib/backgroundTasks";
import { limits } from "../../config/limits";
import { ErrorCode } from "../../shared/errors";
import { toClientError } from "../../shared/errorHandling";
import { detectFileCategory } from "./loaders/fileType";
import { convertToPdfBuffer } from "./loaders/convertToPdf";
import { runPdfPipeline } from "./loaders/pdfPipeline";
import { runStructuredPipeline } from "./loaders/structuredPipeline";
import { addDocumentsToStore, deleteDocumentsByDocumentId } from "./langchain/vectorStore";
import { moduleLogger } from "../../lib/logger";

const log = moduleLogger("ingestion");

/**
 * Background queue for knowledge-base ingestion (parse → convert/OCR → embed → store), backed by
 * PostgreSQL so it needs no extra infrastructure and survives restarts.
 *
 * - Enqueue: the upload mutation stores the bytes in an IngestionJob next to a PROCESSING document
 *   and returns at once.
 * - Claim: workers take the oldest due job with FOR UPDATE SKIP LOCKED, so each job goes to exactly
 *   one worker across all instances, and hold a lease (lockedUntil) renewed while they work. If a
 *   worker dies, the lease runs out and another worker picks the job up.
 * - Finish: the document becomes READY (chunks stored) or FAILED (with a message for the user), and
 *   the job row — with its bytes — is deleted. Temporary failures (a service unavailable or rate
 *   limited) are retried with exponential backoff; anything else fails immediately.
 * - Wake-ups: a new job wakes this process's workers at once, and other instances' via Redis when
 *   configured; otherwise idle workers only sweep occasionally, which lets a serverless database
 *   (Neon) suspend when nothing is happening.
 */

const WAKE_CHANNEL = "ingestion:queued";

interface ClaimedJob {
  id: string;
  documentId: string;
  userId: string;
  filename: string;
  sourceUrl: string | null;
  attempts: number;
}

/** Takes the oldest due job, or null. Atomic across every worker on every instance. */
async function claimNextJob(): Promise<ClaimedJob | null> {
  const rows = await prisma.$queryRaw<ClaimedJob[]>`
    UPDATE "IngestionJob"
    SET "lockedUntil" = NOW() + (${limits.ingestionLeaseMs}::int * INTERVAL '1 millisecond'),
        "attempts" = "attempts" + 1
    WHERE "id" = (
      SELECT "id" FROM "IngestionJob"
      WHERE "runAfter" <= NOW() AND ("lockedUntil" IS NULL OR "lockedUntil" < NOW())
      ORDER BY "createdAt"
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING "id", "documentId", "userId", "filename", "sourceUrl", "attempts"`;
  return rows[0] ?? null;
}

function renewLease(jobId: string) {
  return prisma.$executeRaw`
    UPDATE "IngestionJob"
    SET "lockedUntil" = NOW() + (${limits.ingestionLeaseMs}::int * INTERVAL '1 millisecond')
    WHERE "id" = ${jobId}`;
}

/** Temporary conditions worth another attempt; anything else (e.g. an unreadable file) fails now. */
function isRetryable(err: unknown): boolean {
  const { code } = toClientError(err);
  return code === ErrorCode.SERVICE_UNAVAILABLE || code === ErrorCode.RATE_LIMITED;
}

async function runPipeline(job: ClaimedJob, buffer: Buffer) {
  const category = detectFileCategory(job.filename);
  if (category === "unsupported") throw new Error(`Unsupported file type for "${job.filename}".`);
  const baseMetadata = {
    documentId: job.documentId,
    userId: job.userId,
    title: job.filename,
    sourceUrl: job.sourceUrl ?? undefined,
  };
  const { chunks, warning } =
    category === "structured"
      ? { chunks: await runStructuredPipeline(buffer, job.filename, baseMetadata), warning: null }
      : await runPdfPipeline(category === "pdf" ? buffer : await convertToPdfBuffer(buffer, job.filename), baseMetadata);
  await addDocumentsToStore(chunks);
  return { chunkCount: chunks.length, pipeline: category, warning };
}

async function processJob(job: ClaimedJob): Promise<void> {
  const startedAt = Date.now();
  log.info({ documentId: job.documentId, attempt: job.attempts }, "ingestion started");
  const heartbeat = setInterval(() => {
    renewLease(job.id).catch((err) => log.warn({ err, jobId: job.id }, "renewing the job lease failed"));
  }, Math.max(1_000, Math.floor(limits.ingestionLeaseMs / 3)));
  heartbeat.unref();

  try {
    const payload = await prisma.ingestionJob.findUnique({ where: { id: job.id }, select: { data: true } });
    if (!payload) return; // the document was deleted (cascading to its job) after the claim

    // A previous attempt may have stored some chunks before failing: start clean.
    await deleteDocumentsByDocumentId(job.documentId);
    const { chunkCount, pipeline, warning } = await runPipeline(job, Buffer.from(payload.data));

    const [updated] = await prisma.$transaction([
      prisma.document.updateMany({
        where: { id: job.documentId },
        data: { status: "READY", error: null, warning, chunkCount, pipeline, mongoDocId: job.documentId },
      }),
      prisma.ingestionJob.deleteMany({ where: { id: job.id } }),
    ]);
    // Deleted while it was being processed: don't leave its chunks behind.
    if (updated.count === 0) await deleteDocumentsByDocumentId(job.documentId);
    log.info(
      { documentId: job.documentId, chunkCount, pipeline, durationMs: Date.now() - startedAt, deletedMeanwhile: updated.count === 0 },
      "ingestion finished"
    );
  } catch (err) {
    await deleteDocumentsByDocumentId(job.documentId).catch(() => undefined);
    const reason = err instanceof Error ? err.message : String(err);
    if (isRetryable(err) && job.attempts < limits.ingestionMaxAttempts) {
      const delayMs = limits.ingestionRetryBaseMs * 2 ** (job.attempts - 1);
      log.warn({ err, documentId: job.documentId, attempt: job.attempts, retryInMs: delayMs }, "ingestion attempt failed; will retry");
      await prisma.ingestionJob.updateMany({
        where: { id: job.id },
        data: { lockedUntil: null, runAfter: new Date(Date.now() + delayMs), lastError: reason.slice(0, 1000) },
      });
    } else {
      log.error({ err, documentId: job.documentId, attempts: job.attempts, durationMs: Date.now() - startedAt }, "ingestion failed");
      await prisma.$transaction([
        prisma.document.updateMany({
          where: { id: job.documentId },
          data: { status: "FAILED", error: failureMessage(err) },
        }),
        prisma.ingestionJob.deleteMany({ where: { id: job.id } }),
      ]);
    }
  } finally {
    clearInterval(heartbeat);
  }
}

/** What the user is told; internal details stay in the logs. */
function failureMessage(err: unknown): string {
  const client = toClientError(err);
  if (client.expected || client.code !== ErrorCode.INTERNAL_SERVER_ERROR) return client.message;
  return "We couldn't read this file. Check that it isn't corrupted or password-protected, then upload it again.";
}

// ── Worker ──────────────────────────────────────────────────────────────────────────────────

let running = false;
const sleepers = new Set<() => void>();
let stopListening: (() => Promise<void>) | null = null;

function wakeLocalWorkers() {
  for (const wake of [...sleepers]) wake();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      sleepers.delete(done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    sleepers.add(done);
  });
}

async function workerLoop() {
  while (running) {
    let job: ClaimedJob | null;
    try {
      job = await claimNextJob();
    } catch (err) {
      log.error({ err }, "claiming an ingestion job failed");
      await sleep(limits.ingestionErrorBackoffMs);
      continue;
    }
    if (!job) {
      await sleep(limits.ingestionIdlePollMs);
      continue;
    }
    const work = processJob(job);
    trackBackground(work); // shutdown waits for it; if it can't, the lease hands it to another worker
    await work.catch((err) => log.error({ err }, "unexpected ingestion worker error"));
  }
}

/** Starts `concurrency` workers in this process. */
export async function startIngestionWorker(concurrency: number): Promise<void> {
  if (running) return;
  running = true;
  if (getRedis()) {
    stopListening = await subscribe(WAKE_CHANNEL, wakeLocalWorkers).catch((err) => {
      log.warn({ err }, "can't listen for new jobs over Redis; relying on polling");
      return null;
    });
  }
  for (let i = 0; i < concurrency; i++) void workerLoop();
  log.info({ concurrency }, "ingestion worker running");
}

/** Stops claiming new jobs; jobs in progress finish (and are drained on shutdown). */
export async function stopIngestionWorker(): Promise<void> {
  running = false;
  wakeLocalWorkers();
  await stopListening?.();
  stopListening = null;
}

/** Tells workers a job is waiting: this process's immediately, other instances' via Redis. */
export function notifyJobQueued(): void {
  wakeLocalWorkers();
  getRedis()
    ?.publish(WAKE_CHANNEL, "1")
    .catch(() => {});
}
