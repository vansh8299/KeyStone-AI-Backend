import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { Conversation } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { env } from "../../config/env";
import { limits } from "../../config/limits";
import { getChatModel } from "../rag/langchain/chatModel";
import { traceConfig } from "../../lib/langsmith";
import { extractText, NonEmptyTextSchema } from "../rag/langchain/llmOutput";
import { clipHistoryMessage } from "../rag/langchain/history";
import { getEmbeddingProvider } from "../rag/embeddings";
import { loadTree, pathTo } from "../conversation/messageTree";
import { messageTextWithAttachments } from "../attachment/attachment.service";

type PastChat = Pick<Conversation, "id" | "title" | "historySummary" | "historySummaryEmbedding" | "updatedAt">;

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return normA && normB ? dot / Math.sqrt(normA * normB) : 0;
}

async function mostRelated(chats: PastChat[], question: string, k: number): Promise<PastChat[]> {
  if (chats.length === 0 || k <= 0) return [];
  const query = await getEmbeddingProvider().embed(question);
  return chats
    .filter((c) => c.historySummaryEmbedding.length === query.length)
    .map((c) => ({ c, score: cosineSimilarity(query, c.historySummaryEmbedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(({ c }) => c);
}

function formatPastChat(chat: PastChat): string {
  const date = chat.updatedAt.toISOString().slice(0, 10);
  const title = chat.title ? ` "${chat.title}"` : "";
  return `- [${date}]${title}: ${chat.historySummary}`;
}

export async function retrievePastConversations(
  userId: string,
  currentConversationId: string,
  question: string
): Promise<string> {
  if (!env.referenceChatHistory) return "";
  try {
    const chats: PastChat[] = await prisma.conversation.findMany({
      where: { userId, id: { not: currentConversationId }, historySummary: { not: null } },
      orderBy: { updatedAt: "desc" },
      take: limits.pastChatsCandidates,
      select: { id: true, title: true, historySummary: true, historySummaryEmbedding: true, updatedAt: true },
    });
    const recent = chats.slice(0, limits.pastChatsRecent);
    const older = chats.slice(limits.pastChatsRecent);

    let related: PastChat[] = [];
    if (older.length > 0) {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<PastChat[]>((resolve) => {
        timer = setTimeout(() => {
          console.warn("Past-conversation ranking timed out; using recent conversations only.");
          resolve([]);
        }, limits.pastChatsRankingTimeoutMs);
      });
      const ranked = mostRelated(older, question, limits.pastChatsRelated).catch((err) => {
        console.error("Past-conversation ranking failed:", err);
        return [];
      });
      related = await Promise.race([ranked, timeout]);
      clearTimeout(timer);
    }

    const sections: string[] = [];
    if (recent.length > 0) sections.push(`Most recent:\n${recent.map(formatPastChat).join("\n")}`);
    if (related.length > 0) {
      sections.push(`Older, related to the current message:\n${related.map(formatPastChat).join("\n")}`);
    }
    return sections.join("\n\n");
  } catch (err) {
    console.error("Past-conversation retrieval failed:", err);
    return "";
  }
}

const NOTHING_TO_REMEMBER = "NOTHING_TO_REMEMBER";

const SUMMARY_PROMPT =
  `You write the assistant's memory of a conversation with a user, so that in their FUTURE, ` +
  `separate conversations the assistant can recall what was discussed and what it learned about ` +
  `them.\n\n` +
  `Capture: what the user was working on, asking about or trying to achieve; what was concluded, ` +
  `decided or left open; and anything the user revealed about themselves — name, role, ` +
  `background, projects, tools they use, preferences for how they like answers.\n` +
  `Leave out: greetings, general knowledge the assistant explained, long details, and secrets or ` +
  `credentials (passwords, API keys, account numbers).\n\n` +
  `Write 1–4 plain sentences in the third person ("The user…"), at most about 80 words, no ` +
  `bullet points or headings. Reply with the summary only.\n\n` +
  `If there is nothing worth remembering — only greetings, small talk, thanks, or a test message, ` +
  `with no real topic or request — reply with exactly ${NOTHING_TO_REMEMBER} and nothing else.`;

type BranchMessage = { role: string; content: string; summary: string | null; metadata: unknown };

function transcriptFor(branch: BranchMessage[]): string {
  let start = 0;
  let earlier = "";
  for (let i = branch.length - 1; i >= 0; i--) {
    if (branch[i].summary) {
      earlier = branch[i].summary!;
      start = i + 1;
      break;
    }
  }
  const recent = branch
    .slice(start)
    .map((m) => `${m.role === "USER" ? "User" : "Assistant"}: ${clipHistoryMessage(messageTextWithAttachments(m.content, m.metadata))}`)
    .join("\n\n");
  const text = (earlier ? `Summary of the earlier part:\n${earlier}\n\n` : "") + recent;
  return text.length > limits.pastChatSummaryInputChars
    ? `…${text.slice(text.length - limits.pastChatSummaryInputChars)}`
    : text;
}

const inFlight = new Set<string>();

export type RememberResult = "summarised" | "nothing" | "skipped";

export async function rememberConversation(
  conversationId: string,
  leafId: string,
  { force = false }: { force?: boolean } = {}
): Promise<RememberResult> {
  if (!env.referenceChatHistory || inFlight.has(conversationId)) return "skipped";
  inFlight.add(conversationId);
  try {
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { historySummary: true, historySummaryMessages: true },
    });
    if (!conversation) return "skipped";

    const branch = pathTo(await loadTree(conversationId), leafId).filter(
      (m) => m.role === "USER" || m.role === "ASSISTANT"
    );
    const count = branch.length;
    const checkedAt = conversation.historySummaryMessages;
    const every = conversation.historySummary ? limits.pastChatSummaryEvery : limits.pastChatSummaryFirstAt;
    const due =
      checkedAt > 0
        ? count >= checkedAt + every || count < checkedAt
        : count >= limits.pastChatSummaryFirstAt;
    if (!due && !force) return "skipped";

    const response = await getChatModel(limits.pastChatSummaryMaxTokens).invoke(
      [new SystemMessage(SUMMARY_PROMPT), new HumanMessage(`Conversation:\n${transcriptFor(branch)}`)],
      traceConfig("long_term_memory_summary", { conversationId }, ["background", "memory"])
    );
    const parsed = NonEmptyTextSchema.safeParse(extractText(response.content));
    if (!parsed.success) return "skipped";
    const nothing = parsed.data.includes(NOTHING_TO_REMEMBER);
    const embedding = nothing ? [] : await getEmbeddingProvider().embed(parsed.data);

    const current = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { updatedAt: true },
    });
    if (!current) return "skipped";
    await prisma.conversation.updateMany({
      where: { id: conversationId },
      data: {
        historySummary: nothing ? null : parsed.data,
        historySummaryEmbedding: embedding,
        historySummaryMessages: count,
        updatedAt: current.updatedAt,
      },
    });
    return nothing ? "nothing" : "summarised";
  } catch (err) {
    console.error("Past-conversation summary failed:", err);
    return "skipped";
  } finally {
    inFlight.delete(conversationId);
  }
}
