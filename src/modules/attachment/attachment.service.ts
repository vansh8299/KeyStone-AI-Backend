import { prisma } from "../../lib/prisma";
import { limits } from "../../config/limits";
import { badUserInputError, notFoundError, payloadTooLargeError } from "../../shared/errors";
import { ImageParseError, parseImage } from "./imageParser";
import {
  checkDocumentBytes,
  DOCUMENT_EXTENSIONS,
  DOCUMENT_MIME_TYPES,
  DocumentReadError,
  readDocument,
  type DocumentExtension,
} from "../rag/langchain/documentReader";
import { getEmbeddingProvider } from "../rag/embeddings";

export type AttachmentKind = "image" | "document";

export interface MessageAttachment {
  id: string;
  kind?: AttachmentKind;
  filename: string;
  mimeType: string;
  parsedText?: string;
  summary?: string | null;
  pageCount?: number | null;
}

const isDocument = (a: Pick<MessageAttachment, "kind">) => a.kind === "document";

const IMAGE_SIGNATURES: { mimeType: string; matches: (b: Buffer) => boolean }[] = [
  { mimeType: "image/png", matches: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mimeType: "image/jpeg", matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mimeType: "image/gif", matches: (b) => ["GIF87a", "GIF89a"].includes(b.subarray(0, 6).toString("latin1")) },
  {
    mimeType: "image/webp",
    matches: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
  },
];

function detectImageType(data: Buffer): string | null {
  return IMAGE_SIGNATURES.find((s) => s.matches(data))?.mimeType ?? null;
}

function documentExtension(filename: string): DocumentExtension | null {
  const ext = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  return (DOCUMENT_EXTENSIONS as readonly string[]).includes(ext ?? "") ? (ext as DocumentExtension) : null;
}

function cleanFilename(filename: string, fallback: string): string {
  const base = filename.split(/[\\/]/).pop() ?? "";
  return base.replace(/\p{Cc}/gu, "").trim().slice(0, 200) || fallback;
}

async function deleteStaleUploads() {
  await prisma.attachment.deleteMany({
    where: { conversationId: null, createdAt: { lt: new Date(Date.now() - limits.unsentAttachmentTtlMs) } },
  });
}

async function embedAll(texts: string[]): Promise<number[][]> {
  const provider = getEmbeddingProvider();
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += 100) {
    vectors.push(...(await provider.embedMany(texts.slice(i, i + 100))));
  }
  return vectors;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return normA && normB ? dot / Math.sqrt(normA * normB) : 0;
}

const UNSUPPORTED =
  "Unsupported file. Attach an image (PNG, JPEG, WebP, GIF) or a document (PDF, Word .docx, " +
  "Excel .xlsx/.xls, CSV, .txt or Markdown).";

const RETURNED_FIELDS = {
  id: true,
  kind: true,
  filename: true,
  mimeType: true,
  size: true,
  summary: true,
  pageCount: true,
  createdAt: true,
} as const;

export const attachmentService = {
  async upload({ userId, filename, data }: { userId: string; filename: string; data: Buffer }) {
    if (data.length === 0) throw badUserInputError("The file is empty.");
    const imageType = detectImageType(data);
    const upload = imageType
      ? await this.readImage(filename, data, imageType)
      : await this.readDocumentFile(filename, data);
    deleteStaleUploads().catch((err) => console.error("Unsent attachment cleanup failed:", err));

    const { chunks, ...fields } = upload;
    const created = await prisma.attachment.create({
      data: { userId, size: data.length, data, ...fields },
      select: { ...RETURNED_FIELDS, parsedText: true },
    });
    if (chunks.length > 0) {
      await prisma.attachmentChunk.createMany({
        data: chunks.map((c, index) => ({ attachmentId: created.id, index, ...c })),
      });
    }
    return { ...created, parsedText: created.kind === "image" ? created.parsedText : null };
  },

  async readImage(filename: string, data: Buffer, mimeType: string) {
    if (data.length > limits.chatImageMaxBytes) {
      throw payloadTooLargeError(`Images can be at most ${limits.chatImageMaxBytes / 1024 / 1024} MB.`);
    }
    const parsedText = await parseImage(data, mimeType).catch((err) => {
      throw err instanceof ImageParseError
        ? badUserInputError("This image couldn't be read. Try a clearer or larger image.")
        : err;
    });
    return {
      kind: "image" as const,
      filename: cleanFilename(filename, "image"),
      mimeType,
      parsedText,
      summary: null,
      pageCount: null,
      chunks: [] as { text: string; location: string | null; embedding: number[] }[],
    };
  },

  async readDocumentFile(filename: string, data: Buffer) {
    const ext = documentExtension(filename);
    if (!ext) {
      throw badUserInputError(
        filename.toLowerCase().endsWith(".doc")
          ? "Old Word .doc files aren't supported. Save it as .docx and attach it again."
          : UNSUPPORTED
      );
    }
    if (data.length > limits.chatDocumentMaxBytes) {
      throw payloadTooLargeError(`Documents can be at most ${limits.chatDocumentMaxBytes / 1024 / 1024} MB.`);
    }
    const problem = checkDocumentBytes(ext, data);
    if (problem) throw badUserInputError(problem);

    const read = await readDocument(filename, ext, data).catch((err) => {
      throw err instanceof DocumentReadError ? badUserInputError(err.message) : err;
    });
    const vectors = read.chunks.length > 0 ? await embedAll(read.chunks.map((c) => c.text)) : [];
    return {
      kind: "document" as const,
      filename: cleanFilename(filename, `document.${ext}`),
      mimeType: DOCUMENT_MIME_TYPES[ext],
      parsedText: read.text,
      summary: read.truncated ? `${read.summary}\n\n(Only the first part of this very long document was read.)` : read.summary,
      pageCount: read.pageCount,
      chunks: read.chunks.map((c, i) => ({ ...c, embedding: vectors[i] ?? [] })),
    };
  },

  async resolve(userId: string, ids: string[], conversationId: string | null): Promise<MessageAttachment[]> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return [];
    if (unique.length > limits.chatImagesPerMessage) {
      throw badUserInputError(`You can attach up to ${limits.chatImagesPerMessage} files per message.`);
    }
    const found = await prisma.attachment.findMany({
      where: {
        id: { in: unique },
        userId,
        OR: [{ conversationId: null }, ...(conversationId ? [{ conversationId }] : [])],
      },
      select: { id: true, kind: true, filename: true, mimeType: true, parsedText: true, summary: true, pageCount: true },
    });
    if (found.length !== unique.length) {
      throw notFoundError("An attached file is no longer available. Please attach it again.");
    }
    return unique.map((id) => {
      const a = found.find((f) => f.id === id)!;
      return a.kind === "document"
        ? { id: a.id, kind: "document", filename: a.filename, mimeType: a.mimeType, summary: a.summary, pageCount: a.pageCount }
        : { id: a.id, kind: "image", filename: a.filename, mimeType: a.mimeType, parsedText: a.parsedText };
    });
  },

  async linkToConversation(userId: string, ids: string[], conversationId: string) {
    if (ids.length === 0) return;
    await prisma.attachment.updateMany({ where: { id: { in: ids }, userId }, data: { conversationId } });
  },

  findForUser(id: string, userId: string) {
    return prisma.attachment.findFirst({
      where: { id, userId },
      select: { data: true, mimeType: true, filename: true, kind: true },
    });
  },

  async documentContext(ids: string[], question: string): Promise<{ context: string; overview: string }> {
    const none = { context: "", overview: "" };
    if (ids.length === 0) return none;
    const docs = await prisma.attachment.findMany({
      where: { id: { in: ids }, kind: "document" },
      select: { id: true, filename: true, parsedText: true, summary: true, pageCount: true, _count: { select: { chunks: true } } },
    });
    const ordered = ids.map((id) => docs.find((d) => d.id === id)).filter((d): d is (typeof docs)[number] => !!d);
    if (ordered.length === 0) return none;

    const describe = (d: (typeof ordered)[number], i: number) => {
      const unit = /\.(xlsx|xls|csv)$/i.test(d.filename) ? "sheet" : "page";
      const size = d.pageCount ? ` (${d.pageCount} ${unit}${d.pageCount === 1 ? "" : "s"})` : "";
      return `Document ${i + 1}: "${d.filename}"${size}`;
    };
    const overview = ordered.map((d, i) => `${describe(d, i)}\nSummary: ${d.summary ?? "(none)"}`).join("\n\n");

    const longIds = ordered.filter((d) => d._count.chunks > 0).map((d) => d.id);
    const excerpts = new Map<string, { location: string | null; text: string; index: number }[]>();
    if (longIds.length > 0) {
      const [queryVector, chunks] = await Promise.all([
        getEmbeddingProvider().embed(question),
        prisma.attachmentChunk.findMany({
          where: { attachmentId: { in: longIds } },
          select: { attachmentId: true, index: true, location: true, text: true, embedding: true },
        }),
      ]);
      const best = chunks
        .map((c) => ({ c, score: cosineSimilarity(queryVector, c.embedding) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limits.documentChunksPerQuestion);
      for (const { c } of best) {
        excerpts.set(c.attachmentId, [...(excerpts.get(c.attachmentId) ?? []), c]);
      }
    }

    let budget = limits.documentContextMaxChars;
    const sections: string[] = [];
    for (const [i, d] of ordered.entries()) {
      const header = describe(d, i);
      let body: string;
      if (d._count.chunks === 0 && d.parsedText.length <= budget) {
        body = `Full text:\n${d.parsedText}`;
      } else if (d._count.chunks === 0) {
        body = `Summary:\n${d.summary ?? "(none)"}\n\nText (beginning):\n${d.parsedText}`;
      } else {
        const parts = (excerpts.get(d.id) ?? [])
          .sort((a, b) => a.index - b.index)
          .map((e) => `(${e.location ?? `part ${e.index + 1}`}) ${e.text}`);
        body =
          `Summary:\n${d.summary ?? "(none)"}` +
          (parts.length > 0
            ? `\n\nExcerpts most relevant to the question (the document is long, so only these parts are shown):\n${parts.join("\n\n")}`
            : `\n\n(The document is long; none of its passages matched this question closely.)`);
      }
      const section = `${header}\n${body}`;
      if (section.length > budget) {
        if (budget > 500) sections.push(section.slice(0, budget) + "\n…[truncated]");
        break;
      }
      sections.push(section);
      budget -= section.length;
    }
    return { context: sections.join("\n\n---\n\n"), overview };
  },
};

export function formatImagesForPrompt(attachments: MessageAttachment[]): string {
  return attachments
    .filter((a) => !isDocument(a))
    .map((a, i) => `Image ${i + 1} ("${a.filename}"):\n${a.parsedText ?? ""}`)
    .join("\n\n");
}

export function messageTextWithAttachments(content: string, metadata: unknown): string {
  const attachments = attachmentsOf(metadata);
  if (attachments.length === 0) return content;
  const images = formatImagesForPrompt(attachments);
  const documents = attachments
    .filter(isDocument)
    .map((a) => `Document "${a.filename}": ${a.summary ?? ""}`)
    .join("\n\n");
  return [content, images && `[Attached images]\n${images}`, documents && `[Attached documents]\n${documents}`]
    .filter(Boolean)
    .join("\n\n");
}

export function attachmentsOf(metadata: unknown): MessageAttachment[] {
  const list = (metadata as { attachments?: unknown } | null)?.attachments;
  return Array.isArray(list) ? (list as MessageAttachment[]) : [];
}

export function documentIdsOf(messages: { metadata: unknown }[]): string[] {
  return [...messages]
    .reverse()
    .flatMap((m) => attachmentsOf(m.metadata).filter(isDocument).map((a) => a.id));
}
