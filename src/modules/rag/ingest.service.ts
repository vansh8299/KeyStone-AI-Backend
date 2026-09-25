import { createHash } from "node:crypto";
import { prisma } from "../../lib/prisma";
import { limits } from "../../config/limits";
import { badUserInputError, conflictError } from "../../shared/errors";
import { documentService } from "../document/document.service";
import { detectFileCategory } from "./loaders/fileType";
import { convertToPdfBuffer } from "./loaders/convertToPdf";
import { runPdfPipeline } from "./loaders/pdfPipeline";
import { runStructuredPipeline } from "./loaders/structuredPipeline";
import { addDocumentsToStore, deleteDocumentsByDocumentId } from "./langchain/vectorStore";

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
  async ingestFile(rawInput: IngestFileInput) {
    const input = { ...rawInput, filename: cleanFilename(rawInput.filename) };
    const category = detectFileCategory(input.filename);
    if (category === "unsupported") {
      throw badUserInputError(
        `Unsupported file type for "${input.filename}". Supported: pdf, docx, doc, txt, md, rtf, xlsx, xls, csv.`
      );
    }

    // Checked before any chunking / embedding so a duplicate costs nothing but the hash.
    const hash = contentHash(input.buffer);
    const existing = await prisma.document.findUnique({
      where: { userId_contentHash: { userId: input.userId, contentHash: hash } },
      select: { title: true },
    });
    if (existing) throw duplicateError(existing.title);

    let document;
    try {
      document = await prisma.document.create({
        data: { userId: input.userId, title: input.filename, sourceUrl: input.sourceUrl, contentHash: hash },
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

    try {
      const baseMetadata = {
        documentId: document.id,
        userId: input.userId,
        title: input.filename,
        sourceUrl: input.sourceUrl,
      };

      const chunks =
        category === "structured"
          ? await runStructuredPipeline(input.buffer, input.filename, baseMetadata)
          : await runPdfPipeline(
              category === "pdf" ? input.buffer : await convertToPdfBuffer(input.buffer, input.filename),
              baseMetadata
            );

      await addDocumentsToStore(chunks);
      await prisma.document.update({ where: { id: document.id }, data: { mongoDocId: document.id } });
      return { document, chunkCount: chunks.length, pipeline: category };
    } catch (err) {
      await deleteDocumentsByDocumentId(document.id).catch(() => undefined);
      await prisma.document.delete({ where: { id: document.id } }).catch(() => undefined);
      throw err;
    }
  },

  async ingestText(input: { userId: string; title: string; content: string; sourceUrl?: string }) {
    return this.ingestFile({
      userId: input.userId,
      filename: `${input.title}.md`,
      buffer: Buffer.from(input.content, "utf-8"),
      sourceUrl: input.sourceUrl,
    });
  },

  async deleteIngested(documentId: string, userId: string) {
    const document = await documentService.requireOwned(documentId, userId);

    const deletedChunks = await deleteDocumentsByDocumentId(documentId);
    await prisma.document.delete({ where: { id: documentId } });

    console.log(`Deleted document ${documentId} ("${document.title}") and ${deletedChunks} chunks`);
    return true;
  },
};
