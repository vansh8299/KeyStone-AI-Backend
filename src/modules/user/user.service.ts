import { prisma } from "../../lib/prisma";
import { conversationService } from "../conversation/conversation.service";
import type { ConversationPage } from "../conversation/conversation.schemas";

export const userService = {
  findById(id: string) {
    return prisma.user.findUnique({ where: { id } });
  },
  findConversations(userId: string, page: ConversationPage) {
    return conversationService.findManyByUser(userId, page);
  },
};
