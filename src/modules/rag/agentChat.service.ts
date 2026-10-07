import { randomBytes } from "crypto";
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
import { documentService } from "../document/document.service";
import { ActiveTurn, activeTurns } from "./activeTurns";
import {
  attachmentService,
  attachmentsOf,
  formatImagesForPrompt,
  documentIdsOf,
  MessageAttachment,
} from "../attachment/attachment.service";
import { runInBackground, trackBackground } from "../../lib/backgroundTasks";
import { moduleLogger } from "../../lib/logger";
import { toClientError } from "../../shared/errorHandling";
import { detectFileRequest, FILE_FORMAT_LABELS } from "./responseFiles/fileRequest";
import { createResponseFile, type ResponseFile } from "./responseFiles/responseFile";

const log = moduleLogger("chat");

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
  /** The text streamed so far was withdrawn (the reviewer asked for a revision). */
  onReset?: () => void;
}

export interface ChatTurnResult {
  answer: string;
  /** PDF or Word files made for this reply (the user asked for one). */
  files: ResponseFile[];
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
  | { type: "RESET" }
  | { type: "DONE"; conversationId: string; result: ChatTurnResult };

export function streamChatTurn(
  input: Omit<ChatTurnInput, "onConversation" | "onToken" | "onStatus" | "onReset">
): AsyncGenerator<AgentStreamEvent> {
  const turn = new ActiveTurn(input.userId);
  let conversationId: string | null = null;

  const work = runChatTurn({
    ...input,
    onConversation: (id) => {
      conversationId = id;
      activeTurns.register(id, turn);
      turn.publish({ type: "CONVERSATION", conversationId: id });
    },
    onToken: (text) => turn.publish({ type: "TOKEN", text }),
    onStatus: (status) => turn.publish({ type: "STATUS", status }),
    onReset: () => turn.publish({ type: "RESET" }),
  })
    .then((result) => turn.publish({ type: "DONE", conversationId: result.conversationId, result }))
    .catch((err) => turn.fail(err))
    .finally(() => {
      if (conversationId) activeTurns.release(conversationId, turn);
    });
  trackBackground(work);

  return turn.events();
}

export async function* attachToChatTurn(userId: string, conversationId: string): AsyncGenerator<AgentStreamEvent> {
  const events = await activeTurns.follow(conversationId, userId);
  if (!events) return;
  yield { type: "CONVERSATION", conversationId };
  yield* events;
}

/**
 * One chat turn, logged as a single summary line: which conversation, how long it took (and until
 * the first token), which sources answered, and how the answer review went. Failures are logged
 * with their error code; unexpected ones are also logged in full where they're turned into errors.
 */
export async function runChatTurn(input: ChatTurnInput): Promise<ChatTurnResult> {
  const startedAt = performance.now();
  let firstTokenMs: number | undefined;
  let conversationId = input.conversationId ?? undefined;
  const branch = input.editMessageId ? "edit" : input.regenerateMessageId ? "regenerate" : "new";
  try {
    const result = await runChatTurnInner({
      ...input,
      onConversation: (id) => {
        conversationId = id;
        input.onConversation?.(id);
      },
      onToken: (text) => {
        firstTokenMs ??= Math.round(performance.now() - startedAt);
        input.onToken?.(text);
      },
    });
    log.info(
      {
        userId: input.userId,
        conversationId: result.conversationId,
        branch,
        durationMs: Math.round(performance.now() - startedAt),
        firstTokenMs,
        tools: result.toolsUsed,
        review: result.review,
        needsHumanInput: result.needsHumanInput,
        attachments: input.attachmentIds?.length ?? 0,
      },
      "chat turn finished"
    );
    const { review: _review, ...publicResult } = result;
    return publicResult;
  } catch (err) {
    log.warn(
      { userId: input.userId, conversationId, branch, durationMs: Math.round(performance.now() - startedAt), errorCode: toClientError(err).code },
      "chat turn failed"
    );
    throw err;
  }
}

async function runChatTurnInner({
  userId,
  question,
  conversationId,
  editMessageId,
  regenerateMessageId,
  attachmentIds,
  onConversation,
  onToken,
  onStatus,
  onReset,
}: ChatTurnInput): Promise<ChatTurnResult & { review: string | null }> {
  const newAttachments =
    attachmentIds != null && !regenerateMessageId
      ? await attachmentService.resolve(userId, attachmentIds, conversationId ?? null)
      : null;

  let convoId: string;
  let activeLeafId: string | null = null;
  let tree: Awaited<ReturnType<typeof loadTree>> | null = null;
  if (conversationId) {
    // Load the tree alongside the ownership check; it's only used once ownership is confirmed.
    const treeLoad = loadTree(conversationId);
    treeLoad.catch(() => {});
    const existing = await conversationService.requireOwned(conversationId, userId);
    convoId = existing.id;
    activeLeafId = existing.activeLeafId;
    tree = await treeLoad;
  } else {
    if (editMessageId || regenerateMessageId) {
      throw badUserInputError("conversationId is required to edit or regenerate a message");
    }
    const conversation = await conversationService.create({ userId });
    convoId = conversation.id;
  }

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
  const [shortTerm, pastConversations, documents, knowledgeBaseDocumentIds, account, fileRequest] = await Promise.all([
    buildShortTermMemory(branch),
    retrievePastConversations(userId, convoId, agentQuestion),
    attachmentService.documentContext(documentIds, agentQuestion),
    // Fetched now, alongside the memory, rather than mid-answer by the knowledge-base search.
    documentService.idsForUser(userId),
    prisma.user.findUnique({ where: { id: userId }, select: { name: true } }),
    // Whether they want the reply as a PDF or Word file (only checked when one is mentioned).
    detectFileRequest(agentQuestion),
  ]);
  const memory = {
    userId,
    userName: account?.name?.trim() || undefined,
    outputFile: fileRequest?.format,
    ...shortTerm,
    pastConversations,
    attachedImages: formatImagesForPrompt(attachments),
    attachedDocuments: documents.context,
    documentOverview: documents.overview,
    hasAttachments: attachments.length > 0,
    knowledgeBaseDocumentIds,
  };

  const previous = branch[branch.length - 1];
  const pendingHitl = previous?.role === "ASSISTANT" ? getHitl(previous.metadata) : undefined;
  const pendingClarification =
    previous && pendingHitl?.status === "pending" ? { message: previous, hitl: pendingHitl } : null;
  const resumeClarification = pendingClarification && attachments.length === 0;

  // Saving the user's message doesn't hold up the answer: its ID is chosen here, the writes run
  // alongside the agent, and they're awaited before the reply (its child) is saved.
  const userMessageId = existingUserMessage?.id ?? newMessageId();
  const userMessageSaved = Promise.all([
    existingUserMessage
      ? null
      : prisma.message.create({
          data: {
            id: userMessageId,
            conversationId: convoId,
            parentId,
            role: "USER",
            content: trimmedQuestion,
            source: "NONE",
            ...(attachments.length > 0
              ? { metadata: { attachments: attachments.map((a) => ({ ...a })) } }
              : {}),
          },
        }),
    newAttachments && !existingUserMessage
      ? attachmentService.linkToConversation(userId, newAttachments.map((a) => a.id), convoId)
      : null,
    conversationService.setActiveLeaf(convoId, userMessageId),
  ]);
  userMessageSaved.catch(() => {}); // awaited below; if the agent fails first, that error wins

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
      result = await resumeAgent(pendingClarification.hitl.threadId, agentQuestion, { onToken, onStatus, onReset }, trace);
    } catch (err) {
      if (!(err instanceof NoPausedRunError)) throw err;
      result = await askAgent(agentQuestion, memory, { onToken, onStatus, onReset }, trace);
    }
  } else {
    result = await askAgent(agentQuestion, memory, { onToken, onStatus, onReset }, trace);
  }
  const traceMetadata = trace.runId ? { langsmithRunId: trace.runId } : {};
  await userMessageSaved;

  // The file is made from the final, reviewed answer, so a withheld answer gets none.
  let files: ResponseFile[] = [];
  let fileError: string | undefined;
  if (
    fileRequest &&
    result.status === "completed" &&
    result.guardrail.status !== "withheld" &&
    result.answer.trim() &&
    !isFileRefusal(result.answer)
  ) {
    onStatus?.("CREATING_FILE");
    try {
      files = [await createResponseFile({ userId, conversationId: convoId, markdown: result.answer, request: fileRequest })];
    } catch (err) {
      log.error({ err, conversationId: convoId, format: fileRequest.format }, "creating a response file failed");
      fileError = `The ${FILE_FORMAT_LABELS[fileRequest.format]} couldn't be created. Ask again to retry.`;
    }
  }

  const interrupted = result.status === "interrupted";
  const { answer, toolsUsed, source, metadata } =
    result.status === "interrupted"
      ? {
          answer: result.interrupt.question,
          toolsUsed: [] as string[],
          source: "NONE" as const,
          metadata: {
            toolsUsed: [] as string[],
            hitl: { type: "clarification", status: "pending", threadId: result.threadId } satisfies HitlMetadata,
            ...traceMetadata,
          },
        }
      : {
          answer: result.answer,
          toolsUsed: result.toolsUsed,
          source: mapToolsToSource(result.toolsUsed),
          metadata: {
            toolsUsed: result.toolsUsed,
            guardrail: { ...result.guardrail, issues: [...result.guardrail.issues] },
            ...(files.length > 0 ? { files: files.map((f) => ({ ...f })) } : {}),
            ...(fileError ? { fileError } : {}),
            ...traceMetadata,
          },
        };

  // The reply, the conversation's active message and a resolved clarification are independent
  // writes, so they go out together rather than one after another.
  const assistantMessageId = newMessageId();
  await Promise.all([
    prisma.message.create({
      data: {
        id: assistantMessageId,
        conversationId: convoId,
        parentId: userMessageId,
        role: "ASSISTANT",
        content: answer,
        source,
        metadata,
        inputTokens: result.tokenUsage?.inputTokens,
        outputTokens: result.tokenUsage?.outputTokens,
        totalTokens: result.tokenUsage?.totalTokens,
      },
    }),
    conversationService.setActiveLeaf(convoId, assistantMessageId),
    pendingClarification
      ? prisma.message.update({
          where: { id: pendingClarification.message.id },
          data: {
            metadata: {
              ...(pendingClarification.message.metadata as object),
              hitl: { ...pendingClarification.hitl, status: "resolved" },
            },
          },
        })
      : null,
  ]);

  runInBackground("short-term memory", () => refreshShortTermMemory(convoId, assistantMessageId));
  runInBackground("long-term memory", () => rememberConversation(convoId, assistantMessageId));

  return {
    answer,
    toolsUsed,
    conversationId: convoId,
    needsHumanInput: interrupted,
    review: result.status === "completed" ? result.guardrail.status : null,
    userMessageId,
    assistantMessageId,
    files,
  };
}

/**
 * A reply that only says files can't be made ("I can't generate PDFs, but you can…") rather than
 * being the document: turning it into a PDF would hand the user a file of the refusal.
 */
function isFileRefusal(answer: string): boolean {
  const start = answer.slice(0, 300);
  return (
    !/^\s*#/m.test(answer.slice(0, 200)) &&
    /\b(can(?:no|')t|unable to|not able to|don'?t have the ability)\b/i.test(start) &&
    /\b(pdf|word|docx?|files?|download)/i.test(start)
  );
}

function questionForFilesOnly(attachments: MessageAttachment[]): string {
  const docs = attachments.filter((a) => a.kind === "document").length;
  const images = attachments.length - docs;
  if (docs === 0) return images === 1 ? "What's in this image?" : "What's in these images?";
  if (images === 0) return docs === 1 ? "Summarize this document." : "Summarize these documents.";
  return "What's in these files?";
}

/**
 * A message ID chosen before the row is written (so work can start without waiting for the
 * insert). Same shape as Prisma's cuid(): lowercase, starts with "c", 25 characters.
 */
function newMessageId(): string {
  return `c${Date.now().toString(36)}${randomBytes(12).toString("hex")}`.slice(0, 25);
}
