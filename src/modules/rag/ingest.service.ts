import { prisma } from "../../lib/prisma";
import { limits } from "../../config/limits";
import { badUserInputError } from "../../shared/errors";
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

    const document = await prisma.document.create({
      data: { userId: input.userId, title: input.filename, sourceUrl: input.sourceUrl },
    });

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
