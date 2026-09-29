import { GraphQLContext } from "../../context";
import { requireAuth } from "../../shared/requireAuth";
import { conversationService } from "./conversation.service";
import { IdArgsSchema, parseInput, singleLineText } from "../../shared/validate";
import { BranchArgsSchema, ConversationPageArgsSchema } from "./conversation.schemas";
import { createRateLimiter } from "../../shared/rateLimit";
import { z } from "zod";
import { limits } from "../../config/limits";

const titleLimiter = createRateLimiter({
  name: "title",
  limit: 30,
  windowMs: 10 * 60 * 1000,
  message: "Too many requests. Please wait a few minutes and try again.",
});

const CreateConversationArgsSchema = z.object({
  input: z
    .object({
      title: z
        .string()
        .nullish()
        .transform((t) => t?.trim() || undefined)
        .pipe(singleLineText(limits.conversationTitleMaxChars).optional()),
    })
    .nullish(),
});

export const conversationController = {
  Query: {
    conversations: (_: unknown, args: unknown, ctx: GraphQLContext) => {
      const userId = requireAuth(ctx);
      return conversationService.findManyByUser(userId, parseInput(ConversationPageArgsSchema, args));
    },

    conversation: (_: unknown, args: unknown, ctx: GraphQLContext) => {
      const userId = requireAuth(ctx);
      const { id } = parseInput(IdArgsSchema, args);
      return conversationService.requireOwnedWithBranch(id, userId);
    },
  },

  Mutation: {
    createConversation: (_: unknown, args: unknown, ctx: GraphQLContext) => {
      const userId = requireAuth(ctx);
      const { input } = parseInput(CreateConversationArgsSchema, args);
      return conversationService.create({ userId, title: input?.title || undefined });
    },

    deleteConversation: async (_: unknown, args: unknown, ctx: GraphQLContext) => {
      const userId = requireAuth(ctx);
      const { id } = parseInput(IdArgsSchema, args);
      await conversationService.requireOwned(id, userId);
      return conversationService.delete(id);
    },

    generateConversationTitle: async (_: unknown, args: unknown, ctx: GraphQLContext) => {
      const userId = requireAuth(ctx);
      const { id } = parseInput(IdArgsSchema, args);
      await titleLimiter.consume(`user:${userId}`);
      await conversationService.requireOwned(id, userId);
      return conversationService.generateTitle(id);
    },

    switchBranch: async (_: unknown, args: unknown, ctx: GraphQLContext) => {
      const userId = requireAuth(ctx);
      const { conversationId, messageId } = parseInput(BranchArgsSchema, args);
      return conversationService.switchBranch(conversationId, userId, messageId);
    },

    rewindConversation: async (_: unknown, args: unknown, ctx: GraphQLContext) => {
      const userId = requireAuth(ctx);
      const { conversationId, messageId } = parseInput(BranchArgsSchema, args);
      return conversationService.rewind(conversationId, userId, messageId);
    },
  },

  Conversation: {
    user: (parent: { userId: string }) => conversationService.findOwner(parent.userId),
    messages: (parent: { id: string; activeLeafId: string | null }) => conversationService.activePath(parent),
    isRewound: (parent: { id: string; activeLeafId: string | null }) =>
      conversationService.isRewound(parent),
  },
};
