import { createHash } from "node:crypto";
import { prisma } from "../../lib/prisma";
import { limits } from "../../config/limits";
import { badUserInputError, conflictError } from "../../shared/errors";
import { documentService } from "../document/document.service";
import { detectFileCategory } from "./loaders/fileType";
import { deleteDocumentsByDocumentId } from "./langchain/vectorStore";
import { notifyJobQueued } from "./ingestionQueue";
import { moduleLogger } from "../../lib/logger";
import { fetchLink } from "./loaders/linkFetcher";
import { toLinkClientError } from "./loaders/linkErrors";

const log = moduleLogger("ingestion");

export interface IngestFileInput {
  userId: string;
  filename: string;
  buffer: Buffer;
  sourceUrl?: string;
}

export function contentHash(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function duplicateError(existingTitle: string) {
  return conflictError(`This content is already in your knowledge base as "${existingTitle}".`);
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

function cleanFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? "";
  return base.replace(/\p{Cc}/gu, "").trim().slice(-limits.ingestTitleMaxChars) || "document";
}

export const ingestService = {
  /**
   * Accepts a file for the knowledge base: validates it, rejects duplicates, and queues it for a
   * background worker (see ingestionQueue.ts). Returns the new document straight away with status
   * PROCESSING; it becomes READY (searchable) or FAILED once processed.
   */
  async ingestFile(rawInput: IngestFileInput) {
    const input = { ...rawInput, filename: cleanFilename(rawInput.filename) };
    const category = detectFileCategory(input.filename);
    if (category === "unsupported") {
      throw badUserInputError(
        `Unsupported file type for "${input.filename}". Supported: pdf, docx, doc, txt, md, rtf, xlsx, xls, csv.`
      );
    }

    // Checked before anything is stored, so a duplicate costs nothing but the hash.
    const hash = contentHash(input.buffer);
    const existing = await prisma.document.findUnique({
      where: { userId_contentHash: { userId: input.userId, contentHash: hash } },
      select: { id: true, title: true, status: true },
    });
    if (existing?.status === "READY") throw duplicateError(existing.title);
    if (existing?.status === "PROCESSING") {
      throw conflictError(`This content is already being processed as "${existing.title}".`);
    }
    // A failed earlier attempt with the same content: uploading it again is the retry.
    if (existing) await prisma.document.deleteMany({ where: { id: existing.id, status: "FAILED" } });

    let document;
    try {
      document = await prisma.document.create({
        data: {
          userId: input.userId,
          title: input.filename,
          sourceUrl: input.sourceUrl,
          contentHash: hash,
          status: "PROCESSING",
          job: {
            create: {
              userId: input.userId,
              filename: input.filename,
              sourceUrl: input.sourceUrl,
              data: input.buffer,
            },
          },
        },
      });
    } catch (err) {
      // Two identical uploads raced past the check above; the unique index caught the second.
      if (!isUniqueViolation(err)) throw err;
      const winner = await prisma.document.findUnique({
        where: { userId_contentHash: { userId: input.userId, contentHash: hash } },
        select: { title: true },
      });
      throw duplicateError(winner?.title ?? input.filename);
    }

    notifyJobQueued();
    return { document, chunkCount: null, pipeline: null };
  },

  async ingestText(input: { userId: string; title: string; content: string; sourceUrl?: string }) {
    return this.ingestFile({
      userId: input.userId,
      filename: `${input.title}.md`,
      buffer: Buffer.from(input.content, "utf-8"),
      sourceUrl: input.sourceUrl,
    });
  },

  /** Downloads a public link (document, Google Doc/Sheet/Slides, Drive file or web page) into the knowledge base. */
  async ingestUrl(input: { userId: string; url: string }) {
    const link = await fetchLink(input.url, limits.ingestFileMaxBytes).catch((err) => {
      throw toLinkClientError(err);
    });
    return this.ingestFile({ userId: input.userId, filename: link.filename, buffer: link.data, sourceUrl: input.url });
  },

  async deleteIngested(documentId: string, userId: string) {
    await documentService.requireOwned(documentId, userId);

    const deletedChunks = await deleteDocumentsByDocumentId(documentId);
    await prisma.document.delete({ where: { id: documentId } });

    log.info({ documentId, chunks: deletedChunks }, "knowledge-base document deleted");
    return true;
  },
};
