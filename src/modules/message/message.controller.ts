import { GraphQLContext } from "../../context";
import { requireAuth } from "../../shared/requireAuth";
import { messageService } from "./message.service";
import { conversationService } from "../conversation/conversation.service";

export const messageController = {
  Query: {
    messages: async (
      _: unknown,
      { conversationId }: { conversationId: string },
      ctx: GraphQLContext
    ) => {
      const userId = requireAuth(ctx);
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
  },
};
