import { z } from "zod";
import { idSchema } from "../../shared/validate";

export const BranchArgsSchema = z.object({
  conversationId: idSchema,
  messageId: idSchema,
});

/** Largest page of conversations one request may ask for. */
export const CONVERSATION_PAGE_MAX = 100;

/** Page arguments for conversation lists: newest first, `after` is the last ID of the previous page. */
export const ConversationPageArgsSchema = z.object({
  first: z
    .number()
    .int()
    .min(1, "must be at least 1")
    .max(CONVERSATION_PAGE_MAX, `must be at most ${CONVERSATION_PAGE_MAX}`)
    .nullish()
    .transform((n) => n ?? CONVERSATION_PAGE_MAX),
  after: idSchema.nullish().transform((id) => id ?? undefined),
});
export type ConversationPage = z.infer<typeof ConversationPageArgsSchema>;

export const ConversationIdArgsSchema = z.object({
  conversationId: idSchema,
});
