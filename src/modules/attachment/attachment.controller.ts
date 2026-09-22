import { GraphQLContext } from "../../context";
import { requireAuth } from "../../shared/requireAuth";
import { payloadTooLargeError } from "../../shared/errors";
import { createRateLimiter } from "../../shared/rateLimit";
import { limits } from "../../config/limits";
import { attachmentService } from "./attachment.service";

interface UploadPayload {
  filename: string;
  createReadStream: () => NodeJS.ReadableStream & { destroy?: () => void };
}

const uploadLimiter = createRateLimiter({
  limit: 40,
  windowMs: 10 * 60 * 1000,
  message: "You've attached a lot of files in a short time. Please wait a few minutes.",
});

async function readLimited(stream: NodeJS.ReadableStream & { destroy?: () => void }, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > maxBytes) {
      stream.destroy?.();
      throw payloadTooLargeError(`Files can be at most ${maxBytes / 1024 / 1024} MB.`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

export const attachmentController = {
  Mutation: {
    uploadChatFile: async (_: unknown, { file }: { file: Promise<UploadPayload> }, ctx: GraphQLContext) => {
      const userId = requireAuth(ctx);
      uploadLimiter.consume(`user:${userId}`);
      const upload = await file;
      const data = await readLimited(upload.createReadStream(), Math.max(limits.chatDocumentMaxBytes, limits.chatImageMaxBytes));
      return attachmentService.upload({ userId, filename: upload.filename, data });
    },
  },
};
