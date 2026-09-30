import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { Message } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { limits } from "../../config/limits";
import { getChatModel } from "../rag/langchain/chatModel";
import { traceConfig } from "../../lib/langsmith";
import { extractText, NonEmptyTextSchema } from "../rag/langchain/llmOutput";
import { ChatHistoryMessage, clipHistoryMessage } from "../rag/langchain/history";
import { loadTree, pathTo } from "../conversation/messageTree";
import { messageTextWithAttachments } from "../attachment/attachment.service";
import { moduleLogger } from "../../lib/logger";

const log = moduleLogger("memory");

export interface ShortTermMemory {
  summary: string;
  history: ChatHistoryMessage[];
}

type BranchMessage = Pick<Message, "id" | "role" | "content" | "summary" | "metadata">;

function chatMessages(branch: BranchMessage[]): BranchMessage[] {
  return branch
    .filter((m) => CHAT_ROLES.has(m.role))
    .map((m) => ({ ...m, content: messageTextWithAttachments(m.content, m.metadata) }));
}

const CHAT_ROLES = new Set(["USER", "ASSISTANT"]);

function countFromEnd(messages: BranchMessage[], maxMessages: number, maxChars: number): number {
  let count = 0;
  let chars = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    chars += clipHistoryMessage(messages[i].content).length;
    if (count > 0 && (count >= maxMessages || chars > maxChars)) break;
    count++;
  }
  return count;
}

function splitAtLatestSummary(branch: BranchMessage[]) {
  for (let i = branch.length - 1; i >= 0; i--) {
    if (branch[i].summary) {
      return { summary: branch[i].summary!, unsummarized: branch.slice(i + 1) };
    }
  }
  return { summary: "", unsummarized: branch };
}

const SUMMARY_PROMPT =
  `You maintain a running summary of a conversation between a user and an AI assistant, so the ` +
  `assistant can remember older parts of it. Update the existing summary with the new messages.\n\n` +
  `Keep: the user's goals and questions, facts they shared about themselves or their situation, ` +
  `preferences and instructions (e.g. "answer briefly", "I use Python"), names, numbers, decisions, ` +
  `conclusions the assistant reached, and anything still unresolved.\n` +
  `Drop: greetings, filler, and detail that is no longer relevant.\n\n` +
  `Write concise plain-text notes (bullet points are fine), in the third person ("The user…"), at ` +
  `most about 250 words. Reply with the updated summary only.`;

async function summarize(previousSummary: string, messages: BranchMessage[]): Promise<string | null> {
  const transcript = messages
    .map((m) => `${m.role === "USER" ? "User" : "Assistant"}: ${clipHistoryMessage(m.content)}`)
    .join("\n\n");
  const response = await getChatModel(limits.summaryMaxTokens).invoke(
    [
      new SystemMessage(SUMMARY_PROMPT),
      new HumanMessage(
        `Existing summary:\n${previousSummary || "(none yet)"}\n\nNew messages:\n${transcript}`
      ),
    ],
    traceConfig("short_term_memory_summary", {}, ["background", "memory"])
  );
  const parsed = NonEmptyTextSchema.safeParse(extractText(response.content));
  return parsed.success ? parsed.data : null;
}

async function foldOverflow(branch: BranchMessage[]) {
  let { summary, unsummarized } = splitAtLatestSummary(branch);

  while (
    countFromEnd(unsummarized, limits.recentMaxMessages, limits.recentMaxChars) < unsummarized.length
  ) {
    const keep = countFromEnd(unsummarized, limits.recentKeepMessages, limits.recentKeepChars);
    const foldable = unsummarized.slice(0, unsummarized.length - keep);
    const batch = foldable.slice(
      0,
      Math.max(1, countFromStart(foldable, limits.summaryBatchMaxMessages, limits.summaryBatchMaxChars))
    );

    const updated = await summarize(summary, batch);
    if (!updated) break;

    const coveredUpTo = batch[batch.length - 1];
    await prisma.message.update({ where: { id: coveredUpTo.id }, data: { summary: updated } });
    coveredUpTo.summary = updated;
    summary = updated;
    unsummarized = unsummarized.slice(batch.length);
  }

  return { summary, unsummarized };
}

function countFromStart(messages: BranchMessage[], maxMessages: number, maxChars: number): number {
  let count = 0;
  let chars = 0;
  for (const m of messages) {
    chars += clipHistoryMessage(m.content).length;
    if (count > 0 && (count >= maxMessages || chars > maxChars)) break;
    count++;
  }
  return count;
}

export async function buildShortTermMemory(branch: BranchMessage[]): Promise<ShortTermMemory> {
  const chat = chatMessages(branch);

  let summary: string;
  let unsummarized: BranchMessage[];
  try {
    ({ summary, unsummarized } = await foldOverflow(chat));
  } catch (err) {
    log.error({ err }, "short-term memory summarisation failed");
    ({ summary, unsummarized } = splitAtLatestSummary(chat));
  }

  const recent = unsummarized.slice(
    unsummarized.length - countFromEnd(unsummarized, limits.recentMaxMessages, limits.recentMaxChars)
  );
  return {
    summary,
    history: recent.map((m) => ({
      role: m.role === "USER" ? "user" : "assistant",
      content: m.content,
    })),
  };
}

export async function refreshShortTermMemory(conversationId: string, leafId: string): Promise<void> {
  try {
    const branch = pathTo(await loadTree(conversationId), leafId);
    await foldOverflow(chatMessages(branch));
  } catch (err) {
    log.error({ err, conversationId }, "short-term memory refresh failed");
  }
}
