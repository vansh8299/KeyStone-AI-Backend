export type FileCategory = "pdf" | "convertible" | "structured" | "unsupported";

const CONVERTIBLE_EXT = new Set([".docx", ".doc", ".txt", ".md", ".markdown", ".rtf"]);
const STRUCTURED_EXT = new Set([".xlsx", ".xls", ".csv"]);

export function detectFileCategory(filename: string): FileCategory {
  const ext = getExtension(filename);
  if (ext === ".pdf") return "pdf";
  if (CONVERTIBLE_EXT.has(ext)) return "convertible";
  if (STRUCTURED_EXT.has(ext)) return "structured";
  return "unsupported";
}

export function getExtension(filename: string): string {
  const match = filename.toLowerCase().match(/\.[^.]+$/);
  return match ? match[0] : "";
}
