import { prisma } from "../../../lib/prisma";
import { FILE_FORMAT_LABELS, type FileRequest } from "./fileRequest";
import { FILE_MIME_TYPES, firstHeading, renderResponseFile } from "./renderFile";

/** A file the assistant made for a reply, as kept in the message's metadata. */
export interface ResponseFile {
  /** An Attachment row holding the bytes; downloaded from /attachments/:id like any attachment. */
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  format: FileRequest["format"];
}

function fileTitle(markdown: string, request: FileRequest): string {
  const title = firstHeading(markdown) || request.title || "Document";
  // Characters Windows and macOS don't allow in file names, and control characters.
  return title.replace(/[\\/:*?"<>|\p{Cc}]/gu, "").replace(/\s+/g, " ").trim().slice(0, 80) || "Document";
}

/**
 * Turns a reply into the PDF or Word file the user asked for and stores it with the conversation
 * (it's deleted with it).
 */
export async function createResponseFile(input: {
  userId: string;
  conversationId: string;
  markdown: string;
  request: FileRequest;
}): Promise<ResponseFile> {
  const { format } = input.request;
  const title = fileTitle(input.markdown, input.request);
  const data = await renderResponseFile(format, input.markdown, title);
  const created = await prisma.attachment.create({
    data: {
      userId: input.userId,
      conversationId: input.conversationId,
      kind: "document",
      filename: `${title}.${format}`,
      mimeType: FILE_MIME_TYPES[format],
      size: data.length,
      data,
      parsedText: input.markdown,
      summary: `${FILE_FORMAT_LABELS[format]} created by the assistant from its reply.`,
    },
    select: { id: true, filename: true, mimeType: true, size: true },
  });
  return { ...created, format };
}
