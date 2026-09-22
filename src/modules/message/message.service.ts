import { prisma } from "../../lib/prisma";

export const messageService = {
  findManyByConversation(conversationId: string) {
    return prisma.message.findMany({ where: { conversationId }, orderBy: { createdAt: "asc" } });
  },

  findConversation(conversationId: string) {
    return prisma.conversation.findUnique({ where: { id: conversationId } });
  },

  async findSiblingIds(id: string) {
    const message = await prisma.message.findUnique({ where: { id } });
    if (!message) return [];
    const siblings = await prisma.message.findMany({
      where: { conversationId: message.conversationId, parentId: message.parentId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true },
    });
    return siblings.map((m) => m.id);
  },
};
