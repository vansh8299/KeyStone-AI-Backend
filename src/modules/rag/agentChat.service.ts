import { prisma } from "../../lib/prisma";
import { notFoundError, badUserInputError } from "../../shared/errors";
import { conversationService } from "../conversation/conversation.service";
import { loadTree, pathTo } from "../conversation/messageTree";
import {
  askAgent,
  resumeAgent,
  NoPausedRunError,
  AgentResult,
  TokenHandler,
  AgentStatus,
  StatusHandler,
  AgentTrace,
} from "./langchain/agent";
import { newTraceRunId } from "../../lib/langsmith";
import { buildShortTermMemory, refreshShortTermMemory } from "../memory/shortTermMemory";
import { retrievePastConversations, rememberConversation } from "../memory/longTermMemory";
import { KNOWLEDGE_BASE_TOOL_NAME } from "./langchain/tools/knowledgeBaseSearchTool";
import { WEB_SEARCH_TOOL_NAME } from "./langchain/tools/webSearchTool";
import { getHitl, HitlMetadata } from "./hitl";
import { limits } from "../../config/limits";
import { ActiveTurn, activeTurns } from "./activeTurns";
import {
  attachmentService,
  attachmentsOf,
  formatImagesForPrompt,
  documentIdsOf,
  MessageAttachment,
} from "../attachment/attachment.service";

function mapToolsToSource(toolsUsed: string[]): "RAG" | "WEB_SEARCH" | "HYBRID" | "NONE" {
  const usedKb = toolsUsed.includes(KNOWLEDGE_BASE_TOOL_NAME);
  const usedWeb = toolsUsed.includes(WEB_SEARCH_TOOL_NAME);
  if (usedKb && usedWeb) return "HYBRID";
  if (usedWeb) return "WEB_SEARCH";
  if (usedKb) return "RAG";
  return "NONE";
}

export type { HitlMetadata };

export interface ChatTurnInput {
  userId: string;
  question: string;
  conversationId?: string | null;
  editMessageId?: string | null;
  regenerateMessageId?: string | null;
  attachmentIds?: string[] | null;
  onConversation?: (conversationId: string) => void;
  onToken?: TokenHandler;
  onStatus?: StatusHandler;
}

export interface ChatTurnResult {
  answer: string;
  toolsUsed: string[];
  conversationId: string;
  needsHumanInput: boolean;
  userMessageId: string;
  assistantMessageId: string;
}

export type AgentStreamEvent =
  | { type: "CONVERSATION"; conversationId: string }
  | { type: "TOKEN"; text: string }
  | { type: "STATUS"; status: AgentStatus }
  | { type: "DONE"; conversationId: string; result: ChatTurnResult };

export function streamChatTurn(
  input: Omit<ChatTurnInput, "onConversation" | "onToken" | "onStatus">
): AsyncGenerator<AgentStreamEvent> {
  const turn = new ActiveTurn(input.userId);
  let conversationId: string | null = null;

  runChatTurn({
    ...input,
    onConversation: (id) => {
      conversationId = id;
      activeTurns.register(id, turn);
      turn.publish({ type: "CONVERSATION", conversationId: id });
    },
    onToken: (text) => turn.publish({ type: "TOKEN", text }),
    onStatus: (status) => turn.publish({ type: "STATUS", status }),
  })
    .then((result) => turn.publish({ type: "DONE", conversationId: result.conversationId, result }))
    .catch((err) => turn.fail(err))
    .finally(() => {
      if (conversationId) activeTurns.release(conversationId, turn);
    });

  return turn.events();
}

export async function* attachToChatTurn(userId: string, conversationId: string): AsyncGenerator<AgentStreamEvent> {
  const turn = activeTurns.find(conversationId, userId);
  if (!turn) return;
  const events = turn.events();
  yield { type: "CONVERSATION", conversationId };
  yield* events;
}

export async function runChatTurn({
  userId,
  question,
  conversationId,
  editMessageId,
  regenerateMessageId,
  attachmentIds,
  onConversation,
  onToken,
  onStatus,
}: ChatTurnInput): Promise<ChatTurnResult> {
  const newAttachments =
    attachmentIds != null && !regenerateMessageId
      ? await attachmentService.resolve(userId, attachmentIds, conversationId ?? null)
      : null;

  let convoId: string;
  let activeLeafId: string | null = null;
  if (conversationId) {
    const existing = await conversationService.requireOwned(conversationId, userId);
    convoId = existing.id;
    activeLeafId = existing.activeLeafId;
  } else {
    if (editMessageId || regenerateMessageId) {
      throw badUserInputError("conversationId is required to edit or regenerate a message");
    }
    const conversation = await conversationService.create({ userId });
    convoId = conversation.id;
  }

  const tree = conversationId ? await loadTree(convoId) : null;

  let parentId: string | null;
  let existingUserMessage: { id: string; content: string; metadata: unknown } | null = null;
  let editedMessage: { metadata: unknown } | null = null;
  if (regenerateMessageId) {
    const target = tree?.byId.get(regenerateMessageId);
    if (!target) throw notFoundError("Message not found in this conversation");
    const userMessage = target.parentId ? tree!.byId.get(target.parentId) : undefined;
    if (target.role !== "ASSISTANT" || !userMessage || userMessage.role !== "USER") {
      throw badUserInputError("Only an assistant reply to a user message can be regenerated");
    }
    existingUserMessage = userMessage;
    parentId = userMessage.parentId;
  } else if (editMessageId) {
    const target = tree?.byId.get(editMessageId);
    if (!target) throw notFoundError("Message not found in this conversation");
    if (target.role !== "USER") throw badUserInputError("Only user messages can be edited");
    editedMessage = target;
    parentId = target.parentId;
  } else {
    parentId = activeLeafId && tree?.byId.has(activeLeafId) ? activeLeafId : null;
  }

  const trimmedQuestion = existingUserMessage ? existingUserMessage.content : question.trim();
  const attachments: MessageAttachment[] = existingUserMessage
    ? attachmentsOf(existingUserMessage.metadata)
    : newAttachments ?? (editedMessage ? attachmentsOf(editedMessage.metadata) : []);
  if (!trimmedQuestion && attachments.length === 0) {
    throw badUserInputError("Please enter a question or attach a file.", { field: "question" });
  }
  const agentQuestion = trimmedQuestion || questionForFilesOnly(attachments);
  onConversation?.(convoId);

  const branch = tree ? pathTo(tree, parentId) : [];
  const documentIds = [
    ...new Set([...documentIdsOf([{ metadata: { attachments } }]), ...documentIdsOf(branch)]),
  ].slice(0, limits.documentsPerConversation);
  const [shortTerm, pastConversations, documents] = await Promise.all([
    buildShortTermMemory(branch),
    retrievePastConversations(userId, convoId, agentQuestion),
    attachmentService.documentContext(documentIds, agentQuestion),
  ]);
  const memory = {
    userId,
    ...shortTerm,
    pastConversations,
    attachedImages: formatImagesForPrompt(attachments),
    attachedDocuments: documents.context,
    documentOverview: documents.overview,
    hasAttachments: attachments.length > 0,
  };

  const previous = branch[branch.length - 1];
  const pendingHitl = previous?.role === "ASSISTANT" ? getHitl(previous.metadata) : undefined;
  const pendingClarification =
    previous && pendingHitl?.status === "pending" ? { message: previous, hitl: pendingHitl } : null;
  const resumeClarification = pendingClarification && attachments.length === 0;

  let userMessageId: string;
  if (existingUserMessage) {
    userMessageId = existingUserMessage.id;
  } else {
    if (newAttachments) {
      await attachmentService.linkToConversation(userId, newAttachments.map((a) => a.id), convoId);
    }
    const userMessage = await prisma.message.create({
      data: {
        conversationId: convoId,
        parentId,
        role: "USER",
        content: trimmedQuestion,
        source: "NONE",
        ...(attachments.length > 0
          ? { metadata: { attachments: attachments.map((a) => ({ ...a })) } }
          : {}),
      },
    });
    userMessageId = userMessage.id;
  }
  await conversationService.setActiveLeaf(convoId, userMessageId);

  const trace: AgentTrace = {
    runId: newTraceRunId(),
    userId,
    conversationId: convoId,
    user_message_id: userMessageId,
    attachments: attachments.length,
    ...(editMessageId ? { branch: "edit" } : regenerateMessageId ? { branch: "regenerate" } : {}),
  };
  let result: AgentResult;
  if (pendingClarification && resumeClarification) {
    try {
      result = await resumeAgent(pendingClarification.hitl.threadId, agentQuestion, onToken, onStatus, trace);
    } catch (err) {
      if (!(err instanceof NoPausedRunError)) throw err;
      result = await askAgent(agentQuestion, memory, onToken, onStatus, trace);
    }
  } else {
    result = await askAgent(agentQuestion, memory, onToken, onStatus, trace);
  }
  const traceMetadata = trace.runId ? { langsmithRunId: trace.runId } : {};
  if (pendingClarification) {
    await prisma.message.update({
      where: { id: pendingClarification.message.id },
      data: {
        metadata: {
          ...(pendingClarification.message.metadata as object),
          hitl: { ...pendingClarification.hitl, status: "resolved" },
        },
      },
    });
  }

  let answer: string;
  let toolsUsed: string[];
  let assistantMessageId: string;
  if (result.status === "interrupted") {
    answer = result.interrupt.question;
    toolsUsed = [];
    const hitl: HitlMetadata = {
      type: "clarification",
      status: "pending",
      threadId: result.threadId,
    };
    const message = await prisma.message.create({
      data: {
        conversationId: convoId,
        parentId: userMessageId,
        role: "ASSISTANT",
        content: answer,
        source: "NONE",
        metadata: { toolsUsed, hitl: { ...hitl }, ...traceMetadata },
      },
    });
    assistantMessageId = message.id;
  } else {
    answer = result.answer;
    toolsUsed = result.toolsUsed;
    const message = await prisma.message.create({
      data: {
        conversationId: convoId,
        parentId: userMessageId,
        role: "ASSISTANT",
        content: answer,
        source: mapToolsToSource(toolsUsed),
        metadata: {
          toolsUsed,
          guardrail: { ...result.guardrail, issues: [...result.guardrail.issues] },
          ...traceMetadata,
        },
      },
    });
    assistantMessageId = message.id;
  }

  await conversationService.setActiveLeaf(convoId, assistantMessageId);

  void refreshShortTermMemory(convoId, assistantMessageId);
  void rememberConversation(convoId, assistantMessageId);

  return {
    answer,
    toolsUsed,
    conversationId: convoId,
    needsHumanInput: result.status === "interrupted",
    userMessageId,
    assistantMessageId,
  };
}

function questionForFilesOnly(attachments: MessageAttachment[]): string {
  const docs = attachments.filter((a) => a.kind === "document").length;
  const images = attachments.length - docs;
  if (docs === 0) return images === 1 ? "What's in this image?" : "What's in these images?";
  if (images === 0) return docs === 1 ? "Summarize this document." : "Summarize these documents.";
  return "What's in these files?";
}
