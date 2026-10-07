import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import { getChatModel } from "../langchain/chatModel";
import { extractText, parseJsonFromLlm } from "../langchain/llmOutput";
import { traceConfig } from "../../../lib/langsmith";
import { limits } from "../../../config/limits";
import { moduleLogger } from "../../../lib/logger";

const log = moduleLogger("response-files");

export type FileFormat = "pdf" | "docx";

export interface FileRequest {
  format: FileFormat;
  /** A short title for the file, used for its name when the reply has no heading. */
  title: string;
}

export const FILE_FORMAT_LABELS: Record<FileFormat, string> = { pdf: "PDF", docx: "Word document" };

/** Only messages that mention a file format are checked with the model (saves a call on every turn). */
const MENTIONS_FORMAT = /\b(pdf|docx?|word|ms\s*word)\b/i;

const FileRequestSchema = z.object({
  format: z
    .string()
    .transform((s) => s.toLowerCase().replace(/[^a-z]/g, ""))
    .transform((s) => (s === "word" || s === "doc" ? "docx" : s))
    .pipe(z.enum(["pdf", "docx", "none"])),
  title: z.string().trim().max(120).optional().default(""),
});

const PROMPT =
  `Decide whether the user's latest message asks the assistant to PRODUCE a downloadable file for ` +
  `them: create, write, export, convert, give or send something as a PDF or a Word document ` +
  `(.docx). Examples that ARE requests: "give me this as a PDF", "write a cover letter in Word ` +
  `format", "export the summary to docx", "can I get a pdf of the table". Asking ABOUT a file ` +
  `(summarise this PDF, what does the Word doc say, how do I convert PDF to Word) is NOT a request.\n\n` +
  `Reply with JSON only, no code fences:\n` +
  `{"format": "pdf" | "docx" | "none", "title": "<a short title for the file, 2-6 words>"}`;

/** Whether the user wants this reply as a downloadable PDF or Word file, and its title. */
export async function detectFileRequest(question: string): Promise<FileRequest | null> {
  if (!MENTIONS_FORMAT.test(question)) return null;
  try {
    const response = await getChatModel(limits.fileRequestMaxTokens).invoke(
      [new SystemMessage(PROMPT), new HumanMessage(`User's message: ${question}`)],
      traceConfig("file_request_check", {}, ["chat", "response-file"])
    );
    const verdict = parseJsonFromLlm(extractText(response.content), FileRequestSchema);
    if (!verdict || verdict.format === "none") return null;
    return { format: verdict.format, title: verdict.title };
  } catch (err) {
    log.warn({ err }, "checking for a file request failed; answering without a file");
    return null;
  }
}
