import * as XLSX from "xlsx";
import { parse as parseCsv } from "csv-parse/sync";
import { Document } from "@langchain/core/documents";
import { getExtension } from "./fileType";

export interface StructuredPipelineOptions {
  rowsPerChunk?: number;
}

export async function runStructuredPipeline(
  fileBuffer: Buffer,
  filename: string,
  baseMetadata: Record<string, unknown>,
  options: StructuredPipelineOptions = {}
): Promise<Document[]> {
  const ext = getExtension(filename);
  const rowsPerChunk = options.rowsPerChunk ?? 20;

  const sheets: { sheetName: string; rows: Record<string, unknown>[] }[] =
    ext === ".csv" ? [{ sheetName: "csv", rows: parseCsvRows(fileBuffer) }] : parseWorkbook(fileBuffer);

  const documents: Document[] = [];
  let chunkIndex = 0;

  for (const { sheetName, rows } of sheets) {
    for (let start = 0; start < rows.length; start += rowsPerChunk) {
      const group = rows.slice(start, start + rowsPerChunk);
      const text = group.map(serializeRow).join("\n\n");

      documents.push(
        new Document({
          pageContent: text,
          metadata: {
            ...baseMetadata,
            sheetName,
            rowStart: start,
            rowEnd: start + group.length - 1,
            chunkIndex: chunkIndex++,
          },
        })
      );
    }
  }

  return documents;
}

function parseCsvRows(fileBuffer: Buffer): Record<string, unknown>[] {
  return parseCsv(fileBuffer, { columns: true, skip_empty_lines: true });
}

function parseWorkbook(fileBuffer: Buffer): { sheetName: string; rows: Record<string, unknown>[] }[] {
  const workbook = XLSX.read(fileBuffer, { type: "buffer" });
  return workbook.SheetNames.map((sheetName) => ({
    sheetName,
    rows: XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName]),
  }));
}

function serializeRow(row: Record<string, unknown>): string {
  return Object.entries(row)
    .map(([key, value]) => `${key}: ${value}`)
    .join(", ");
}
