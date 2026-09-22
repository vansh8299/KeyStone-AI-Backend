import { z } from "zod";
import { idSchema } from "../../shared/validate";

export const BranchArgsSchema = z.object({
  conversationId: idSchema,
  messageId: idSchema,
});
