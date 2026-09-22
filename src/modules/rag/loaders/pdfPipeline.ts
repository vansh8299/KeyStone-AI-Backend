import fs from "fs/promises";
import os from "os";
import path from "path";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { Document } from "@langchain/core/documents";

export interface PdfPipelineOptions {
  chunkSize?: number;
  chunkOverlap?: number;
}

export async function runPdfPipeline(
  pdfBuffer: Buffer,
  baseMetadata: Record<string, unknown>,
  options: PdfPipelineOptions = {}
): Promise<Document[]> {
  const tmpPath = path.join(os.tmpdir(), `ingest-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
  await fs.writeFile(tmpPath, pdfBuffer);

  try {
    const loader = new PDFLoader(tmpPath, { splitPages: true });
    const pageDocuments = await loader.load();

    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize: options.chunkSize ?? 1000,
      chunkOverlap: options.chunkOverlap ?? 150,
      separators: ["\n\n", "\n", ". ", " ", ""],
    });

    const chunks = await splitter.splitDocuments(pageDocuments);

    return chunks.map(
      (chunk, i) =>
        new Document({
          pageContent: chunk.pageContent,
          metadata: { ...baseMetadata, ...chunk.metadata, chunkIndex: i },
        })
    );
  } finally {
    await fs.unlink(tmpPath).catch(() => undefined);
  }
}
