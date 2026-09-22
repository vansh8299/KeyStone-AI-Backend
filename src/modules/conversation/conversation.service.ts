import { prisma } from "../../lib/prisma";
import { generateTitle } from "./conversation.title";
import { deleteAgentThread } from "../rag/langchain/checkpointer";
import { getHitl } from "../rag/hitl";
import { badUserInputError, notFoundError } from "../../shared/errors";
import { loadTree, pathTo, latestLeafUnder, hasChildren } from "./messageTree";

export interface CreateConversationInput {
  userId: string;
  title?: string;
}

export const conversationService = {
  findById(id: string) {
    return prisma.conversation.findUnique({ where: { id } });
  },

  async requireOwned(id: string, userId: string) {
    const conversation = await prisma.conversation.findUnique({ where: { id } });
    if (!conversation || conversation.userId !== userId) {
      throw notFoundError("This conversation doesn't exist or was deleted.");
    }
    return conversation;
  },

  findManyByUser(userId: string) {
    return prisma.conversation.findMany({ where: { userId }, orderBy: { updatedAt: "desc" } });
  },

  findOwner(id: string) {
    return prisma.user.findUnique({ where: { id } });
  },

  async findActivePath(conversation: { id: string; activeLeafId: string | null }) {
    const tree = await loadTree(conversation.id);
    return pathTo(tree, conversation.activeLeafId);
  },

  async isRewound(conversation: { id: string; activeLeafId: string | null }) {
    const tree = await loadTree(conversation.id);
    return hasChildren(tree, conversation.activeLeafId);
  },

  async switchBranch(conversationId: string, messageId: string) {
    const tree = await loadTree(conversationId);
    if (!tree.byId.has(messageId)) throw notFoundError("Message not found in this conversation");
    return setActiveLeafQuietly(conversationId, latestLeafUnder(tree, messageId));
  },

  async rewind(conversationId: string, messageId: string) {
    const tree = await loadTree(conversationId);
    if (!tree.byId.has(messageId)) throw notFoundError("Message not found in this conversation");
    return setActiveLeafQuietly(conversationId, messageId);
  },

  setActiveLeaf(id: string, activeLeafId: string) {
    return prisma.conversation.update({ where: { id }, data: { activeLeafId } });
  },

  create(input: CreateConversationInput) {
    return prisma.conversation.create({ data: input });
  },

  touch(id: string) {
    return prisma.conversation.update({ where: { id }, data: {} });
  },

  async generateTitle(id: string) {
    const conversation = await prisma.conversation.findUnique({ where: { id } });
    if (!conversation || conversation.title) return conversation;

    const firstMessage = await prisma.message.findFirst({
      where: { conversationId: id, role: "USER" },
      orderBy: { createdAt: "asc" },
    });
    if (!firstMessage) return conversation;

    const title = await generateTitle(firstMessage.content, { userId: conversation.userId, conversationId: id });

    await prisma.conversation.updateMany({ where: { id, title: null }, data: { title } });
    return prisma.conversation.findUnique({ where: { id } });
  },

  async delete(id: string) {
    const assistantMessages = await prisma.message.findMany({
      where: { conversationId: id, role: "ASSISTANT" },
      select: { metadata: true },
    });
    const pendingThreadIds = assistantMessages
      .map((m) => getHitl(m.metadata))
      .filter((hitl) => hitl?.status === "pending")
      .map((hitl) => hitl!.threadId);
    await Promise.all(
      pendingThreadIds.map((threadId) =>
        deleteAgentThread(threadId).catch((err) =>
          console.error(`Failed to delete checkpoints for thread ${threadId}:`, err)
        )
      )
    );

    await prisma.conversation.delete({ where: { id } });
    return true;
  },
};
async function setActiveLeafQuietly(id: string, activeLeafId: string) {
  const conversation = await prisma.conversation.findUnique({ where: { id } });
  if (!conversation) throw notFoundError("Conversation not found");
  return prisma.conversation.update({
    where: { id },
    data: { activeLeafId, updatedAt: conversation.updatedAt },
  });
}
