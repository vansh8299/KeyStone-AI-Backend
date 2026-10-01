import { GraphQLContext } from "../../context";
import { requireAuth } from "../../shared/requireAuth";
import { messageService } from "./message.service";
import { conversationService } from "../conversation/conversation.service";
import { ConversationIdArgsSchema } from "../conversation/conversation.schemas";
import { parseInput } from "../../shared/validate";

export const messageController = {
  Query: {
    messages: async (_: unknown, args: unknown, ctx: GraphQLContext) => {
      const userId = requireAuth(ctx);
      const { conversationId } = parseInput(ConversationIdArgsSchema, args);
      await conversationService.requireOwned(conversationId, userId);
      return messageService.findManyByConversation(conversationId);
    },
  },

  Message: {
    siblingIds: (parent: { id: string; siblingIds?: string[] }) =>
      parent.siblingIds ?? messageService.findSiblingIds(parent.id),
    conversation: (parent: { conversationId: string }) =>
      messageService.findConversation(parent.conversationId),
    metadata: ({ metadata }: { metadata?: unknown }) => {
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return metadata ?? null;
      const { langsmithRunId: _internal, ...visible } = metadata as Record<string, unknown>;
      return visible;
    },
    tokenUsage: ({ inputTokens, outputTokens, totalTokens }: {
      inputTokens?: number | null;
      outputTokens?: number | null;
      totalTokens?: number | null;
    }) => (totalTokens == null ? null : { inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0, totalTokens }),
  },
};
