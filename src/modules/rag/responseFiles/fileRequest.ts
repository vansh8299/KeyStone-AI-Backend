import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import { getChatModel } from "../langchain/chatModel";
import { extractText, parseJsonFromLlm } from "../langchain/llmOutput";
import { traceConfig } from "../../../lib/langsmith";
import { limits } from "../../../config/limits";
import { moduleLogger } from "../../../lib/logger";
import { FILE_FORMATS, FILE_TYPES, FORMAT_ALIASES, type FileFormat } from "./formats";

export { FILE_FORMATS, fileKind, type FileFormat } from "./formats";

const log = moduleLogger("response-files");

export interface FileRequest {
  format: FileFormat;
  /** A short title for the file, used for its name when the reply has no heading. */
  title: string;
}

export const FILE_FORMAT_LABELS = Object.fromEntries(
  FILE_FORMATS.map((f) => [f, FILE_TYPES[f].label])
) as Record<FileFormat, string>;

/**
 * Only messages that could be asking for a file are checked with the model (saves a call on most
 * turns): a format is named, or a file/download is asked for.
 */
const MAY_ASK_FOR_FILE = new RegExp(
  [
    `\\b(${[...FILE_FORMATS, ...Object.keys(FORMAT_ALIASES)].join("|")})\\b`,
    `\\.(${FILE_FORMATS.join("|")})\\b`,
    `\\b(download(able)?|export)\\b`,
    `\\b(give|send|make|create|generate|save|provide|prepare|write|build)\\b.{0,60}\\bfile\\b`,
  ].join("|"),
  "i"
);

const FileRequestSchema = z.object({
  format: z
    .string()
    .transform((s) => s.toLowerCase().replace(/^\./, "").replace(/[^a-z+#]/g, ""))
    .transform((s) => (s === "c++" ? "cpp" : s === "c#" ? "cs" : s))
    .transform((s) => FORMAT_ALIASES[s] ?? s)
    .pipe(z.enum([...FILE_FORMATS, "none"])),
  title: z.string().trim().max(120).optional().default(""),
});

const PROMPT =
  `Decide whether the user's latest message asks the assistant to PRODUCE a downloadable file for ` +
  `them — create, write, export, convert, give or send something as a file — and which kind.\n` +
  `Kinds (answer with the extension): ${FILE_FORMATS.map((f) => `${f} (${FILE_TYPES[f].label})`).join(", ")}.\n` +
  `Examples that ARE requests: "give me this as a PDF" → pdf, "write a cover letter in Word" → ` +
  `docx, "make me a dummy excel file" → xlsx, "export the data as csv" → csv, "make a presentation ` +
  `on climate change" → pptx, "give me the config as a json file" → json, "write a python script ` +
  `file for this" → py, "download that as a text file" → txt.\n` +
  `NOT requests: asking ABOUT a file (summarise this PDF, what does the spreadsheet say), asking how ` +
  `to convert files, or asking for code/text to read in the chat without a file ("write a python ` +
  `function", "show me the JSON"). If they want a file in a kind not listed, pick the closest one.\n\n` +
  `Reply with JSON only, no code fences:\n` +
  `{"format": "<extension>" | "none", "title": "<a short title for the file, 2-6 words>"}`;

/** Whether the user wants this reply as a downloadable file, in which format, and its title. */
export async function detectFileRequest(question: string): Promise<FileRequest | null> {
  if (!MAY_ASK_FOR_FILE.test(question)) return null;
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
