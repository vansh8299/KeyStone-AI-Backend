import { z } from "zod";
import { limits } from "../../config/limits";
import { boundedText, idSchema, optionalUrlSchema } from "../../shared/validate";

export const AskAgentArgsSchema = z
  .object({
    question: z.string().nullish(),
    conversationId: idSchema.nullish(),
    editMessageId: idSchema.nullish(),
    regenerateMessageId: idSchema.nullish(),
    attachmentIds: z
      .array(idSchema)
      .max(limits.chatImagesPerMessage, `can have at most ${limits.chatImagesPerMessage} files`)
      .nullish(),
  })
  .superRefine((args, ctx) => {
    if (args.editMessageId && args.regenerateMessageId) {
      ctx.addIssue({ code: "custom", message: "pass either editMessageId or regenerateMessageId, not both" });
    }
    if ((args.editMessageId || args.regenerateMessageId) && !args.conversationId) {
      ctx.addIssue({ code: "custom", path: ["conversationId"], message: "is required to edit or regenerate" });
    }
  })
  .transform((args, ctx) => {
    if (args.regenerateMessageId) return { ...args, question: "" };
    const text = (args.question ?? "").trim();
    if (!text) return { ...args, question: "" };
    const question = boundedText(limits.questionMaxChars).safeParse(text);
    if (!question.success) {
      ctx.addIssue({ ...question.error.issues[0], path: ["question"] });
      return z.NEVER;
    }
    return { ...args, question: question.data };
  });

export const ConversationTurnArgsSchema = z.object({
  conversationId: idSchema,
});

export const SearchDocumentsArgsSchema = z.object({
  query: boundedText(limits.searchQueryMaxChars),
  topK: z
    .number()
    .int()
    .min(1, "must be at least 1")
    .max(limits.searchTopKMax, `must be at most ${limits.searchTopKMax}`)
    .nullish(),
});

export const IngestFileArgsSchema = z.object({
  sourceUrl: optionalUrlSchema,
});

export const IngestTextArgsSchema = z.object({
  input: z.object({
    title: boundedText(limits.ingestTitleMaxChars),
    content: boundedText(limits.ingestTextMaxChars),
    sourceUrl: optionalUrlSchema,
  }),
});

export const DeleteIngestedDocumentArgsSchema = z.object({
  documentId: idSchema,
});
