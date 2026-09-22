import { prisma } from "../../lib/prisma";

export const userService = {
  findById(id: string) {
    return prisma.user.findUnique({ where: { id } });
  },
  findConversations(userId: string) {
    return prisma.conversation.findMany({ where: { userId }, orderBy: { updatedAt: "desc" } });
  },
};