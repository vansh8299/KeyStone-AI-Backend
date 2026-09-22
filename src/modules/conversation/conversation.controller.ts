import { GraphQLContext } from "../../context";
import { requireAuth } from "../../shared/requireAuth";
import { conversationService } from "./conversation.service";
import { parseInput } from "../../shared/validate";
import { BranchArgsSchema } from "./conversation.schemas";
import { feedbackService } from "../feedback/feedback.service";
import { createRateLimiter } from "../../shared/rateLimit";
import { z } from "zod";
import { limits } from "../../config/limits";

const titleLimiter = createRateLimiter({
  limit: 30,
  windowMs: 10 * 60 * 1000,
  message: "Too many requests. Please wait a few minutes and try again.",
});

const CreateConversationArgsSchema = z.object({
  input: z
    .object({
      title: z
        .string()
        .trim()
        .max(limits.conversationTitleMaxChars, `must be at most ${limits.conversationTitleMaxChars} characters`)
        .nullish(),
    })
    .nullish(),
});

export const conversationController = {
  Query: {
    conversations: (_: unknown, __: unknown, ctx: GraphQLContext) => {
      const userId = requireAuth(ctx);
      return conversationService.findManyByUser(userId);
    },

    conversation: (_: unknown, { id }: { id: string }, ctx: GraphQLContext) => {
      const userId = requireAuth(ctx);
      return conversationService.requireOwned(id, userId);
    },
  },

  Mutation: {
    createConversation: (_: unknown, args: unknown, ctx: GraphQLContext) => {
      const userId = requireAuth(ctx);
      const { input } = parseInput(CreateConversationArgsSchema, args);
      return conversationService.create({ userId, title: input?.title || undefined });
    },

    deleteConversation: async (_: unknown, { id }: { id: string }, ctx: GraphQLContext) => {
      const userId = requireAuth(ctx);
      await conversationService.requireOwned(id, userId);
      return conversationService.delete(id);
    },

    generateConversationTitle: async (_: unknown, { id }: { id: string }, ctx: GraphQLContext) => {
      const userId = requireAuth(ctx);
      titleLimiter.consume(`user:${userId}`);
      await conversationService.requireOwned(id, userId);
      return conversationService.generateTitle(id);
    },

    switchBranch: async (_: unknown, args: unknown, ctx: GraphQLContext) => {
      const userId = requireAuth(ctx);
      const { conversationId, messageId } = parseInput(BranchArgsSchema, args);
      await conversationService.requireOwned(conversationId, userId);
      return conversationService.switchBranch(conversationId, messageId);
    },

    rewindConversation: async (_: unknown, args: unknown, ctx: GraphQLContext) => {
      const userId = requireAuth(ctx);
      const { conversationId, messageId } = parseInput(BranchArgsSchema, args);
      await conversationService.requireOwned(conversationId, userId);
      return conversationService.rewind(conversationId, messageId);
    },
  },

  Conversation: {
    user: (parent: { userId: string }) => conversationService.findOwner(parent.userId),
    messages: async (parent: { id: string; activeLeafId: string | null }) => {
      const path = await conversationService.findActivePath(parent);
      const feedback = await feedbackService.forMessages(path.map((m) => m.id));
      return path.map((m) => ({ ...m, feedback: feedback.get(m.id) ?? null }));
    },
    isRewound: (parent: { id: string; activeLeafId: string | null }) =>
      conversationService.isRewound(parent),
  },
};
