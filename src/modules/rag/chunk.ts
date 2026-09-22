export interface Chunk {
  index: number;
  text: string;
}

export function chunkText(text: string, chunkSize = 500, overlap = 50): Chunk[] {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks: Chunk[] = [];

  let start = 0;
  let index = 0;
  while (start < words.length) {
    const end = Math.min(start + chunkSize, words.length);
    chunks.push({ index, text: words.slice(start, end).join(" ") });
    index += 1;
    if (end === words.length) break;
    start = end - overlap;
  }

  return chunks;
}
