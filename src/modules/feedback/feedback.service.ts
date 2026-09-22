import type { FeedbackRating } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { badUserInputError, notFoundError } from "../../shared/errors";
import { langsmithFeedback } from "../../lib/langsmith";

export const FEEDBACK_CATEGORIES = [
  "not_accurate",
  "not_helpful",
  "incomplete",
  "didnt_follow_instructions",
  "unsafe_or_offensive",
  "other",
] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

export const feedbackService = {
  async set(
    userId: string,
    messageId: string,
    rating: FeedbackRating | null,
    details?: { categories: FeedbackCategory[]; reason: string | null }
  ) {
    const message = await prisma.message.findUnique({
      where: { id: messageId },
      select: { role: true, metadata: true, conversation: { select: { userId: true } } },
    });
    if (!message || message.conversation.userId !== userId) {
      throw notFoundError("This message doesn't exist or was deleted.");
    }
    if (message.role !== "ASSISTANT") {
      throw badUserInputError("Feedback can only be given on the assistant's responses.");
    }

    const meta = message.metadata as { langsmithRunId?: unknown } | null;
    const runId = typeof meta?.langsmithRunId === "string" ? meta.langsmithRunId : undefined;

    if (rating === null) {
      await prisma.messageFeedback.deleteMany({ where: { messageId, userId } });
      void langsmithFeedback.sync(messageId, runId, null);
      return null;
    }
    const cleared = { categories: [], reason: null };
    const given = details && { categories: [...new Set(details.categories)], reason: details.reason?.trim() || null };
    const update = rating === "LIKE" ? cleared : given ?? {};
    const saved = await prisma.messageFeedback.upsert({
      where: { messageId },
      create: { messageId, userId, rating, ...(rating === "DISLIKE" && given ? given : cleared) },
      update: { rating, ...update },
    });
    void langsmithFeedback.sync(messageId, runId, saved);
    return saved;
  },

  async forMessages(messageIds: string[]) {
    if (messageIds.length === 0) return new Map();
    const rows = await prisma.messageFeedback.findMany({ where: { messageId: { in: messageIds } } });
    return new Map(rows.map((f) => [f.messageId, f]));
  },

  forMessage(messageId: string) {
    return prisma.messageFeedback.findUnique({ where: { messageId } });
  },
};
