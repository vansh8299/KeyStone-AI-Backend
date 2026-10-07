import fs from "fs/promises";
import os from "os";
import path from "path";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { Document } from "@langchain/core/documents";
import { readPdfPages } from "../langchain/pdfOcr";
import { limits } from "../../../config/limits";

export interface PdfPipelineOptions {
  chunkSize?: number;
  chunkOverlap?: number;
}

export async function runPdfPipeline(
  pdfBuffer: Buffer,
  baseMetadata: Record<string, unknown>,
  options: PdfPipelineOptions = {}
): Promise<{ chunks: Document[]; warning: string | null }> {
  const tmpPath = path.join(os.tmpdir(), `ingest-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
  await fs.writeFile(tmpPath, pdfBuffer);

  try {
    const loader = new PDFLoader(tmpPath, { splitPages: true });
    // Scanned pages are OCR'd and images on text pages are read, so both become searchable.
    const { docs: pageDocuments, warning } = await readPdfPages(pdfBuffer, await loader.load(), {
      maxPages: limits.ingestPdfVisionMaxPages,
      rateLimitWaitMs: limits.ingestPdfRateLimitWaitBudgetMs,
    });

    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize: options.chunkSize ?? 1000,
      chunkOverlap: options.chunkOverlap ?? 150,
      separators: ["\n\n", "\n", ". ", " ", ""],
    });

    const chunks = await splitter.splitDocuments(pageDocuments);

    return {
      chunks: chunks.map(
        (chunk, i) =>
          new Document({
            pageContent: chunk.pageContent,
            metadata: { ...baseMetadata, ...chunk.metadata, chunkIndex: i },
          })
      ),
      warning,
    };
  } finally {
    await fs.unlink(tmpPath).catch(() => undefined);
  }
}
