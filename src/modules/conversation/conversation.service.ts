import type { MessageFeedback, Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { generateTitle } from "./conversation.title";
import { deleteAgentThread } from "../rag/langchain/checkpointer";
import { getHitl } from "../rag/hitl";
import { notFoundError } from "../../shared/errors";
import { feedbackService } from "../feedback/feedback.service";
import { loadTree, pathTo, latestLeafUnder, hasChildren, type MessageTree } from "./messageTree";
import type { ConversationPage } from "./conversation.schemas";

export interface CreateConversationInput {
  userId: string;
  title?: string;
}

/**
 * The columns the API works with. Leaves out the long-term-memory summary and its embedding
 * (~1,000 floats per conversation), which only longTermMemory reads with its own queries —
 * loading them made listing conversations several times slower.
 */
const conversationColumns = {
  id: true,
  userId: true,
  title: true,
  activeLeafId: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ConversationSelect;

export type ConversationRow = Prisma.ConversationGetPayload<{ select: typeof conversationColumns }>;

interface BranchData {
  tree: MessageTree;
  feedback: Map<string, MessageFeedback>;
}

/**
 * A conversation's message tree and feedback, loaded once per conversation object returned by a
 * resolver and shared by its `messages` and `isRewound` fields (previously each loaded the tree).
 */
const branchDataByConversation = new WeakMap<object, Promise<BranchData>>();

function loadBranchData(conversationId: string): Promise<BranchData> {
  return Promise.all([loadTree(conversationId), feedbackService.forConversation(conversationId)]).then(
    ([tree, feedback]) => ({ tree, feedback })
  );
}

/** Starts loading before ownership is confirmed so both queries run at once; unused if the check fails. */
function prefetchBranchData(conversationId: string): Promise<BranchData> {
  const data = loadBranchData(conversationId);
  data.catch(() => {}); // the ownership error wins; don't also report this as unhandled
  return data;
}

async function findOwned(id: string, userId: string): Promise<ConversationRow> {
  const conversation = await prisma.conversation.findUnique({ where: { id }, select: conversationColumns });
  if (!conversation || conversation.userId !== userId) {
    throw notFoundError("This conversation doesn't exist or was deleted.");
  }
  return conversation;
}

export const conversationService = {
  requireOwned: findOwned,

  /** Like requireOwned, but also loads the messages shown for it, in parallel with the check. */
  async requireOwnedWithBranch(id: string, userId: string) {
    const data = prefetchBranchData(id);
    const conversation = await findOwned(id, userId);
    branchDataByConversation.set(conversation, data);
    return conversation;
  },

  /** One page of the user's conversations, newest activity first (ties broken by ID so pages are stable). */
  findManyByUser(userId: string, { first, after }: ConversationPage) {
    return prisma.conversation.findMany({
      where: { userId },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: first,
      ...(after ? { cursor: { id: after }, skip: 1 } : {}),
      select: conversationColumns,
    });
  },

  findOwner(id: string) {
    return prisma.user.findUnique({ where: { id } });
  },

  branchData(conversation: { id: string }): Promise<BranchData> {
    let data = branchDataByConversation.get(conversation);
    if (!data) {
      data = loadBranchData(conversation.id);
      branchDataByConversation.set(conversation, data);
    }
    return data;
  },

  /** Messages from the root to activeLeafId, each with its siblingIds and feedback. */
  async activePath(conversation: { id: string; activeLeafId: string | null }) {
    const { tree, feedback } = await conversationService.branchData(conversation);
    return pathTo(tree, conversation.activeLeafId).map((m) => ({ ...m, feedback: feedback.get(m.id) ?? null }));
  },

  async isRewound(conversation: { id: string; activeLeafId: string | null }) {
    const { tree } = await conversationService.branchData(conversation);
    return hasChildren(tree, conversation.activeLeafId);
  },

  async switchBranch(conversationId: string, userId: string, messageId: string) {
    return moveActiveLeaf(conversationId, userId, (tree) => {
      if (!tree.byId.has(messageId)) throw notFoundError("Message not found in this conversation");
      return latestLeafUnder(tree, messageId);
    });
  },

  async rewind(conversationId: string, userId: string, messageId: string) {
    return moveActiveLeaf(conversationId, userId, (tree) => {
      if (!tree.byId.has(messageId)) throw notFoundError("Message not found in this conversation");
      return messageId;
    });
  },

  setActiveLeaf(id: string, activeLeafId: string) {
    return prisma.conversation.update({ where: { id }, data: { activeLeafId }, select: conversationColumns });
  },

  create(input: CreateConversationInput) {
    return prisma.conversation.create({ data: input, select: conversationColumns });
  },

  async generateTitle(id: string) {
    const conversation = await prisma.conversation.findUnique({ where: { id }, select: conversationColumns });
    if (!conversation || conversation.title) return conversation;

    const firstMessage = await prisma.message.findFirst({
      where: { conversationId: id, role: "USER" },
      orderBy: { createdAt: "asc" },
    });
    if (!firstMessage) return conversation;

    const title = await generateTitle(firstMessage.content, { userId: conversation.userId, conversationId: id });

    await prisma.conversation.updateMany({ where: { id, title: null }, data: { title } });
    return prisma.conversation.findUnique({ where: { id }, select: conversationColumns });
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

/**
 * Points the conversation at another leaf without bumping updatedAt (browsing a branch isn't new
 * activity). The ownership check and the tree load run together, and the loaded tree is reused
 * for the returned conversation's messages — moving the leaf doesn't change the tree.
 */
async function moveActiveLeaf(conversationId: string, userId: string, pickLeaf: (tree: MessageTree) => string) {
  const data = prefetchBranchData(conversationId);
  const [owned, { tree }] = await Promise.all([findOwned(conversationId, userId), data]);
  const updated = await prisma.conversation.update({
    where: { id: conversationId },
    data: { activeLeafId: pickLeaf(tree), updatedAt: owned.updatedAt },
    select: conversationColumns,
  });
  branchDataByConversation.set(updated, data);
  return updated;
}
