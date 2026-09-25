import { z } from "zod";
import { GraphQLContext } from "../../context";
import { requireAuth } from "../../shared/requireAuth";
import { idSchema, parseInput } from "../../shared/validate";
import { limits } from "../../config/limits";
import { notFoundError } from "../../shared/errors";
import { prisma } from "../../lib/prisma";
import { FEEDBACK_CATEGORIES, feedbackService } from "./feedback.service";

const SetFeedbackArgsSchema = z
  .object({
    messageId: idSchema,
    rating: z.enum(["LIKE", "DISLIKE"]).nullish().transform((r) => r ?? null),
    categories: z
      .array(z.enum(FEEDBACK_CATEGORIES))
      .max(FEEDBACK_CATEGORIES.length)
      .nullish()
      .transform((c) => (c ? [...new Set(c)] : c)),
    reason: z
      .string()
      .max(limits.feedbackReasonMaxChars, `must be at most ${limits.feedbackReasonMaxChars} characters`)
      .nullish()
      .transform((r) => (r == null ? r : r.trim() || null)),
  })
  .superRefine((args, ctx) => {
    const hasDetails = (args.categories?.length ?? 0) > 0 || Boolean(args.reason);
    if (hasDetails && args.rating !== "DISLIKE") {
      ctx.addIssue({ code: "custom", path: ["rating"], message: "Reasons can only be added to a dislike." });
    }
  });

type MessageParent = { id: string; feedback?: unknown };

export const feedbackController = {
  Mutation: {
    setMessageFeedback: async (_: unknown, args: unknown, ctx: GraphQLContext) => {
      const userId = requireAuth(ctx);
      const { messageId, rating, categories, reason } = parseInput(SetFeedbackArgsSchema, args);
      const details =
        categories != null || reason != null ? { categories: categories ?? [], reason: reason ?? null } : undefined;
      const feedback = await feedbackService.set(userId, messageId, rating, details);
      const message = await prisma.message.findUnique({ where: { id: messageId } });
      if (!message) throw notFoundError("This message doesn't exist or was deleted.");
      return { ...message, feedback };
    },
  },

  Message: {
    feedback: (parent: MessageParent) =>
      parent.feedback !== undefined ? parent.feedback : feedbackService.forMessage(parent.id),
  },
};
