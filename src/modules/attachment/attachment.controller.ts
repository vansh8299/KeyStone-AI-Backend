import { GraphQLContext } from "../../context";
import { requireAuth } from "../../shared/requireAuth";
import { createRateLimiter } from "../../shared/rateLimit";
import { limits } from "../../config/limits";
import { attachmentService } from "./attachment.service";
import { checkUploadFilename, readUploadLimited, type UploadPayload } from "../../shared/upload";


const uploadLimiter = createRateLimiter({
  limit: 40,
  windowMs: 10 * 60 * 1000,
  message: "You've attached a lot of files in a short time. Please wait a few minutes.",
});


export const attachmentController = {
  Mutation: {
    uploadChatFile: async (_: unknown, { file }: { file: Promise<UploadPayload> }, ctx: GraphQLContext) => {
      const userId = requireAuth(ctx);
      uploadLimiter.consume(`user:${userId}`);
      const upload = await file;
      const filename = checkUploadFilename(upload.filename);
      const data = await readUploadLimited(
        upload.createReadStream(),
        Math.max(limits.chatDocumentMaxBytes, limits.chatImageMaxBytes)
      );
      return attachmentService.upload({ userId, filename, data });
    },
  },
};
