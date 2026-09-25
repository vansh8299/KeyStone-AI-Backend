import { badUserInputError, payloadTooLargeError } from "./errors";

export interface UploadPayload {
  filename: string;
  createReadStream: () => NodeJS.ReadableStream & { destroy?: () => void };
}

const FILENAME_MAX_CHARS = 255;

/** Rejects missing, over-long or control-character filenames before the upload body is read. */
export function checkUploadFilename(filename: unknown): string {
  if (typeof filename !== "string" || !filename.trim()) {
    throw badUserInputError("The uploaded file has no name.", { field: "file" });
  }
  if (filename.length > FILENAME_MAX_CHARS) {
    throw badUserInputError(`File names can be at most ${FILENAME_MAX_CHARS} characters.`, { field: "file" });
  }
  if (/[\u0000-\u001F\u007F]/.test(filename)) {
    throw badUserInputError("The file name contains invalid characters.", { field: "file" });
  }
  return filename;
}

/** Buffers an upload stream, aborting as soon as it exceeds `maxBytes`; rejects empty files. */
export async function readUploadLimited(
  stream: NodeJS.ReadableStream & { destroy?: () => void },
  maxBytes: number
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > maxBytes) {
      stream.destroy?.();
      throw payloadTooLargeError(`Files can be at most ${Math.round(maxBytes / 1024 / 1024)} MB.`);
    }
    chunks.push(buf);
  }
  if (size === 0) throw badUserInputError("The uploaded file is empty.", { field: "file" });
  return Buffer.concat(chunks);
}
