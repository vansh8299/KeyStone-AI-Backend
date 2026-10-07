import { randomUUID } from "crypto";
import { z } from "zod";
import { StateGraph, Annotation, END, START, interrupt, Command } from "@langchain/langgraph";
import { getCheckpointer, deleteAgentThread } from "./checkpointer";
import {
  ChatHistoryMessage,
  toLangChainMessages,
  formatHistoryTranscript,
  withMemoryContext,
} from "./history";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { getAnswerModel, getChatModel } from "./chatModel";
import { traceConfig, type TraceContext } from "../../../lib/langsmith";
import { createWebSearchTool, WEB_SEARCH_TOOL_NAME } from "./tools/webSearchTool";
import {
  createKnowledgeBaseSearchTool,
  KNOWLEDGE_BASE_TOOL_NAME,
  KnowledgeBaseChunk,
} from "./tools/knowledgeBaseSearchTool";
import {
  createLlmKnowledgeTool,
  LLM_KNOWLEDGE_TOOL_NAME,
  CANNOT_ANSWER_MARKER,
} from "./tools/llmKnowledgeTool";
import { documentService } from "../../document/document.service";
import { env } from "../../../config/env";
import { limits, clipText } from "../../../config/limits";
import {
  extractText,
  parseJsonFromLlm,
  AmbiguityVerdictSchema,
  EntryLabelSchema,
  NonEmptyTextSchema,
  GuardrailVerdict,
} from "./llmOutput";
import { AnswerDraft, reviewAnswer, reviseAnswer, withheldAnswerMessage } from "./guardrails";
import { runInBackground } from "../../../lib/backgroundTasks";
import { moduleLogger } from "../../../lib/logger";
import { TokenUsage, TokenUsageTracker } from "./tokenUsage";

const log = moduleLogger("agent");

const knowledgeBaseSearchTool = createKnowledgeBaseSearchTool();
const llmKnowledgeTool = createLlmKnowledgeTool();
const KB_NO_MATCH_MARKER = "NOT_IN_CONTEXT";

const CONVERSATIONAL_PATTERNS: RegExp[] = [
  /^(hi|hello|hey|yo|hola|howdy)[\s!.,]*$/i,
  /^good\s?(morning|afternoon|evening|night)[\s!.,]*$/i,
  /^(how are you|what'?s up|how'?s it going|sup)[\s?!.,]*$/i,
  /^(thanks|thank you|thx|ty|appreciate it)[\s!.,]*$/i,
  /^(bye|goodbye|see ya|see you|later|take care)[\s!.,]*$/i,
  /^(ok|okay|cool|great|nice|got it|alright|sounds good)[\s!.,]*$/i,
];

function isConversational(question: string): boolean {
  const trimmed = question.trim();
  if (trimmed.length === 0) return true;
  return CONVERSATIONAL_PATTERNS.some((pattern) => pattern.test(trimmed));
}

const KB_TERMS = /\b(knowledge\s?base|kb|(my|the|our)\s+(uploaded\s+)?(documents?|docs|files?))\b/i;
const KB_LISTING_INTENT =
  /\b(what|which|list|show|see|contains?|have|has|inside|available|uploaded|stored|there)\b/i;
const KB_TOPIC_QUESTION =
  /\b(about|regarding|say|says|explain|summari[sz]e|according|mention|mentions|how|why|when|where)\b/i;
const KB_INVENTORY_MAX_WORDS = 14;

function asksAboutKnowledgeBaseContents(question: string): boolean {
  const q = question.trim();
  if (q.split(/\s+/).filter(Boolean).length > KB_INVENTORY_MAX_WORDS) return false;
  return KB_TERMS.test(q) && KB_LISTING_INTENT.test(q) && !KB_TOPIC_QUESTION.test(q);
}

const CLASSIFY_WORD_COUNT_LIMIT = 6;

async function classifyEntry(question: string): Promise<"directAnswer" | "checkAmbiguity"> {
  const trimmed = question.trim();
  if (isConversational(trimmed)) return "directAnswer";

  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  if (wordCount > CLASSIFY_WORD_COUNT_LIMIT) return "checkAmbiguity";

  const llm = getChatModel(limits.classifyMaxTokens);
  const response = await llm.invoke([
    new SystemMessage(
      "Classify the user's message as exactly one word: " +
        `"GREETING" if it's a greeting, small talk, thanks, or farewell with no real question ` +
        `or request in it (this includes casual/misspelled variants like "hii", "heyyy", "yo"), ` +
        `or "QUESTION" if it asks something or requests help, however short or informal. ` +
        "Reply with only that single word, nothing else."
    ),
    new HumanMessage(trimmed),
  ]);

  const label = EntryLabelSchema.safeParse(extractText(response.content));
  return label.success && label.data === "GREETING" ? "directAnswer" : "checkAmbiguity";
}

const GraphState = Annotation.Root({
  question: Annotation<string>(),
  history: Annotation<ChatHistoryMessage[]>({
    default: () => [],
    reducer: (_prev, next) => next,
  }),
  conversationSummary: Annotation<string>({
    default: () => "",
    reducer: (_prev, next) => next,
  }),
  pastConversations: Annotation<string>({
    default: () => "",
    reducer: (_prev, next) => next,
  }),
  outputFile: Annotation<"pdf" | "docx" | "">({
    default: () => "",
    reducer: (_prev, next) => next,
  }),
  userName: Annotation<string>({
    default: () => "",
    reducer: (_prev, next) => next,
  }),
  attachedImages: Annotation<string>({
    default: () => "",
    reducer: (_prev, next) => next,
  }),
  attachedDocuments: Annotation<string>({
    default: () => "",
    reducer: (_prev, next) => next,
  }),
  documentOverview: Annotation<string>({
    default: () => "",
    reducer: (_prev, next) => next,
  }),
  userId: Annotation<string>({
    default: () => "",
    reducer: (_prev, next) => next,
  }),
  hasAttachments: Annotation<boolean>({
    default: () => false,
    reducer: (_prev, next) => next,
  }),
  /** The user's knowledge-base document IDs, fetched up front; null means look them up when searching. */
  kbDocumentIds: Annotation<string[] | null>({
    default: () => null,
    reducer: (_prev, next) => next,
  }),
  clarification: Annotation<string>({
    default: () => "",
    reducer: (_prev, next) => next,
  }),
  kbChunks: Annotation<KnowledgeBaseChunk[]>({
    default: () => [],
    reducer: (_prev, next) => next,
  }),
  answer: Annotation<string>({
    default: () => "",
    reducer: (_prev, next) => next,
  }),
  toolsUsed: Annotation<string[]>({
    default: () => [],
    reducer: (prev, next) => Array.from(new Set([...prev, ...next])),
  }),
  sourceContext: Annotation<string>({
    default: () => "",
    reducer: (_prev, next) => next,
  }),
  guardrail: Annotation<GuardrailOutcome>({
    default: () => ({ status: "pending", revisions: 0, issues: [] }),
    reducer: (_prev, next) => next,
  }),
});

export interface GuardrailOutcome {
  status: "pending" | "passed" | "revised" | "withheld" | "skipped";
  revisions: number;
  issues: { category: string; feedback: string }[];
}

type GraphStateType = typeof GraphState.State;

function memoryContext(state: GraphStateType) {
  return {
    userName: state.userName,
    outputFile: state.outputFile,
    conversationSummary: state.conversationSummary,
    pastConversations: state.pastConversations,
    attachedImages: state.attachedImages,
    attachedDocuments: state.attachedDocuments,
  };
}

/** The opening message of a chat: nothing earlier for the ambiguity check to resolve references against. */
function isFirstMessage(state: GraphStateType): boolean {
  return state.history.length === 0 && !state.conversationSummary && !state.hasAttachments;
}

async function routeEntry(
  state: GraphStateType
): Promise<"directAnswer" | "checkAmbiguity" | "searchKnowledgeBase" | "listKnowledgeBase"> {
  if (state.hasAttachments) return "checkAmbiguity";
  if (asksAboutKnowledgeBaseContents(state.question)) return "listKnowledgeBase";
  const route = await classifyEntry(state.question);
  // The check mainly rewrites follow-ups ("what about the second one?") into standalone questions,
  // which a first message never needs; skipping it saves an LLM round trip before the answer.
  // Trade-off: a vague opening question is answered as best it can be instead of clarified.
  return route === "checkAmbiguity" && isFirstMessage(state) ? "searchKnowledgeBase" : route;
}

async function checkAmbiguity(state: GraphStateType) {
  const hasHistory = state.history.length > 0;
  const response = await getChatModel(limits.ambiguityCheckMaxTokens).invoke([
    new SystemMessage(
      `You analyse the user's latest message in a conversation and do two things.\n\n` +
        `Context: the user has a personal knowledge base of uploaded documents that the assistant can ` +
        `search. Never mark a question ambiguous just because it mentions "the knowledge base", ` +
        `"my documents" or "my files".\n\n` +
        `1. Standalone question: rewrite the latest message so it can be understood without the ` +
        `earlier conversation — resolve references like "it", "that", "the second one", "what ` +
        `about X?" using the conversation. Keep the user's intent and wording; don't answer it. ` +
        `If it is already standalone, return it unchanged.\n\n` +
        `2. Ambiguity: decide whether the question is STILL too ambiguous to answer well after ` +
        `using the conversation. Mark it ambiguous ONLY if a reasonable assistant genuinely could ` +
        `not tell what is being asked: it refers to something the conversation doesn't identify ` +
        `("fix it", "how much does it cost?" with no prior topic), a key term has several very ` +
        `different meanings with no hint which is meant, or essential details are missing. Most ` +
        `questions are NOT ambiguous — if there is an obvious, common interpretation, it is clear.\n\n` +
        `Reply with JSON only, no code fences:\n` +
        `{"standaloneQuestion": "<rewritten question>", "ambiguous": false}\n` +
        `or\n` +
        `{"standaloneQuestion": "<rewritten question>", "ambiguous": true, "clarifyingQuestion": "<one short, specific question to ask the user>"}`
    ),
    new HumanMessage(
      (state.pastConversations ? `The user's past conversations with you:\n${state.pastConversations}\n\n` : "") +
        (state.conversationSummary
          ? `Summary of the earlier conversation:\n${state.conversationSummary}\n\n`
          : "") +
        (hasHistory
          ? `Conversation so far:\n${formatHistoryTranscript(state.history)}\n\n`
          : `Conversation so far: (none — this is the first message)\n\n`) +
        `Latest message: ${state.question}` +
        (state.attachedImages
          ? `\n\nImages attached to the latest message (parsed; "this"/"it" usually refers to them — ` +
            `put the key details they show into the standalone question):\n${state.attachedImages}`
          : "") +
        (state.documentOverview
          ? `\n\nDocuments attached in this conversation ("it"/"the file"/"the document" usually ` +
            `refers to them). A question these documents could answer is NOT ambiguous — name the ` +
            `document in the standalone question:\n${state.documentOverview}`
          : "")
    ),
  ]);

  const verdict = parseJsonFromLlm(extractText(response.content), AmbiguityVerdictSchema);
  if (!verdict) {
    return { clarification: "" };
  }
  return {
    question: verdict.standaloneQuestion || state.question,
    clarification: verdict.ambiguous && verdict.clarifyingQuestion ? verdict.clarifyingQuestion : "",
  };
}

function routeAfterAmbiguityCheck(state: GraphStateType): "askForClarification" | "searchKnowledgeBase" {
  return state.clarification ? "askForClarification" : "searchKnowledgeBase";
}

const ClarificationInterruptSchema = z.object({
  type: z.literal("clarification"),
  question: z.string(),
  originalQuestion: z.string(),
});
export type ClarificationInterrupt = z.infer<typeof ClarificationInterruptSchema>;

async function askForClarification(state: GraphStateType) {
  const reply = interrupt<ClarificationInterrupt, string>({
    type: "clarification",
    question: state.clarification,
    originalQuestion: state.question,
  });

  const response = await getChatModel(limits.rewriteMaxTokens).invoke([
    new SystemMessage(
      `Rewrite the user's original question into a single, clear, standalone question using ` +
        `their answer to the clarifying question. Keep their intent and wording where possible. ` +
        `Reply with the rewritten question only.`
    ),
    new HumanMessage(
      `Original question: ${state.question}\n` +
        `Clarifying question: ${state.clarification}\n` +
        `User's answer: ${clipText(reply, limits.questionMaxChars)}`
    ),
  ]);

  const clarified = NonEmptyTextSchema.safeParse(extractText(response.content));
  return {
    question: clarified.success ? clarified.data : `${state.question} (${reply})`,
    clarification: "",
  };
}

const KB_LIST_MAX = 50;

async function listKnowledgeBase(state: GraphStateType) {
  const all = state.userId ? await documentService.findManyByUser(state.userId) : [];
  const documents = all.filter((d) => d.status === "READY");
  const processing = all.filter((d) => d.status === "PROCESSING").length;
  const stillProcessing =
    processing > 0
      ? `\n\n${processing} more ${processing === 1 ? "is" : "are"} still being processed and will be searchable shortly.`
      : "";
  const answer =
    documents.length === 0 && processing > 0
      ? `Your documents are still being processed.${stillProcessing}`
      : documents.length === 0
      ? "Your knowledge base is empty right now. Upload documents from the Knowledge base page, " +
        "then ask me questions about them."
      : `Your knowledge base has ${documents.length} document${documents.length === 1 ? "" : "s"}:\n\n` +
        documents
          .slice(0, KB_LIST_MAX)
          .map((d) => `- ${d.title} (added ${d.createdAt.toISOString().slice(0, 10)})`)
          .join("\n") +
        (documents.length > KB_LIST_MAX ? `\n- …and ${documents.length - KB_LIST_MAX} more` : "") +
        stillProcessing +
        "\n\nAsk me anything about them.";
  return {
    answer,
    toolsUsed: [KNOWLEDGE_BASE_TOOL_NAME],
    guardrail: { status: "skipped" as const, revisions: 0, issues: [] },
  };
}

async function directAnswer(state: GraphStateType) {
  const llm = getAnswerModel(state.outputFile);
  const response = await llm.invoke([
    new SystemMessage(
      withMemoryContext(
        "Reply briefly and naturally to this greeting or small talk — one or two short " +
          "sentences, friendly tone. Don't mention documents, sources, or search of any kind.",
        memoryContext(state)
      )
    ),
    ...toLangChainMessages(state.history),
    new HumanMessage(state.question),
  ]);
  return { answer: extractText(response.content) };
}

async function searchKnowledgeBase(state: GraphStateType) {
  // Nothing to search when the user has no documents (known up front for new questions).
  if (!state.userId || state.kbDocumentIds?.length === 0) return { kbChunks: [] };
  const kbChunks = await knowledgeBaseSearchTool.invoke({
    query: state.question,
    topK: 5,
    userId: state.userId,
    ...(state.kbDocumentIds ? { documentIds: state.kbDocumentIds } : {}),
  });
  return { kbChunks };
}

function routeAfterKbSearch(state: GraphStateType): "answerFromKb" | "tryOwnKnowledge" {
  const best = state.kbChunks[0];
  return best && best.score >= env.kbRelevanceThreshold ? "answerFromKb" : "tryOwnKnowledge";
}

async function answerFromKb(state: GraphStateType) {
  const llm = getAnswerModel(state.outputFile);
  const context = clipText(
    state.kbChunks.map((c, i) => `[${i + 1}] (source: ${c.title})\n${c.text}`).join("\n\n---\n\n"),
    limits.kbContextMaxChars
  );

  const response = await llm.invoke([
    new SystemMessage(
      withMemoryContext(
        `Answer the user's question using ONLY the knowledge base context provided below. ` +
          `Mention which source(s) you used. If the context does NOT contain information ` +
          `relevant to the question — even if it's on a related general topic — respond with ` +
          `EXACTLY the single word "${KB_NO_MATCH_MARKER}" and nothing else. Do not say "the ` +
          `context doesn't mention X" as your answer; use the marker for that instead. Also use ` +
          `the marker when the question is about your earlier conversations with the user or about ` +
          `files they attached rather than about these documents — another step answers from those. ` +
          `The earlier conversation is included only so your reply fits it — the facts must come ` +
          `from the context.`,
        memoryContext(state)
      )
    ),
    ...toLangChainMessages(state.history),
    new HumanMessage(`Context:\n${context}\n\nQuestion: ${state.question}`),
  ]);

  const text = extractText(response.content).trim();
  // Models sometimes write "the provided documents don't mention X" instead of the marker; that
  // is a no-match too, so the question still reaches the steps that use memory and the web.
  const answer = isNotInContextReply(text) ? KB_NO_MATCH_MARKER : text;
  return answer === KB_NO_MATCH_MARKER
    ? { answer }
    : { answer, toolsUsed: [KNOWLEDGE_BASE_TOOL_NAME], sourceContext: context };
}

const NOT_FOUND_PHRASE =
  /\b(?:cannot|can't|can not|could not|couldn't|unable to|do not|don't|does not|doesn't|did not|didn't|no|not)\b[^.!?\n]{0,60}\b(?:find|found|see|contain|contains|mention|mentions|include|includes|information|details|reference)\b/i;
const SOURCE_WORDS = /\b(?:context|document|documents|source|sources|material|provided|knowledge base|text|files?|resume)\b/i;

/**
 * A short reply whose opening sentence only says the documents don't cover the question. Longer
 * answers that merely note a gap ("the document doesn't mention X, but…") are kept.
 */
export function isNotInContextReply(text: string): boolean {
  if (text.length > 250) return false;
  const firstSentence = text.split(/(?<=[.!?])\s/)[0];
  return NOT_FOUND_PHRASE.test(firstSentence) && SOURCE_WORDS.test(firstSentence);
}

function routeAfterKbAnswer(state: GraphStateType): "tryOwnKnowledge" | "checkAnswer" {
  return state.answer === KB_NO_MATCH_MARKER ? "tryOwnKnowledge" : "checkAnswer";
}

async function tryOwnKnowledge(state: GraphStateType) {
  const answer = await llmKnowledgeTool.invoke({
    question: state.question,
    history: state.history,
    ...memoryContext(state),
  });
  return answer === CANNOT_ANSWER_MARKER
    ? { answer }
    : { answer, toolsUsed: [LLM_KNOWLEDGE_TOOL_NAME], sourceContext: "" };
}

function routeAfterOwnKnowledge(state: GraphStateType): "webSearch" | "checkAnswer" {
  return state.answer === CANNOT_ANSWER_MARKER ? "webSearch" : "checkAnswer";
}

async function webSearch(state: GraphStateType) {
  if (!env.tavilyApiKey) {
    return {
      answer:
        "I don't have this in the knowledge base or my own training data, and web search " +
        "isn't configured on this server (missing TAVILY_API_KEY).",
    };
  }

  const tool = createWebSearchTool();
  const rawResults = await tool.invoke({ query: state.question });
  const resultsText = clipText(
    typeof rawResults === "string" ? rawResults : JSON.stringify(rawResults),
    limits.webResultsMaxChars
  );

  const llm = getAnswerModel(state.outputFile);
  const response = await llm.invoke([
    new SystemMessage(
      withMemoryContext(
        "Answer the user's question using the web search results below. Note that this answer " +
          "is based on a live web search, since it may be time-sensitive information.",
        memoryContext(state)
      )
    ),
    ...toLangChainMessages(state.history),
    new HumanMessage(`Web search results:\n${resultsText}\n\nQuestion: ${state.question}`),
  ]);

  return {
    answer: extractText(response.content),
    toolsUsed: [WEB_SEARCH_TOOL_NAME],
    sourceContext: resultsText,
  };
}

async function checkAnswer(state: GraphStateType) {
  const { revisions, issues } = state.guardrail;
  if (!env.guardrailsEnabled) {
    return { guardrail: { status: "skipped" as const, revisions, issues } };
  }

  const verdict = await reviewAnswer(answerDraft(state));
  if (verdict.approved) {
    return { guardrail: { status: revisions > 0 ? ("revised" as const) : ("passed" as const), revisions, issues } };
  }

  const allIssues = [...issues, { category: verdict.category, feedback: verdict.feedback }];
  if (revisions >= limits.guardrailMaxRevisions) {
    log.warn({ revisions, category: verdict.category }, "answer review withheld the answer");
    return {
      answer: withheldAnswerMessage(verdict.category),
      guardrail: { status: "withheld" as const, revisions, issues: allIssues },
    };
  }
  return { guardrail: { status: "pending" as const, revisions, issues: allIssues } };
}

function routeAfterCheck(state: GraphStateType): "reviseAnswer" | typeof END {
  return state.guardrail.status === "pending" ? "reviseAnswer" : END;
}

async function reviseAnswerNode(state: GraphStateType) {
  const { revisions, issues } = state.guardrail;
  const latest = issues[issues.length - 1];
  const revised = await reviseAnswer(answerDraft(state), {
    approved: false,
    category: (latest?.category ?? "quality") as GuardrailVerdict["category"],
    feedback: latest?.feedback ?? "",
  });
  return {
    ...(revised ? { answer: revised } : {}),
    guardrail: { status: "pending" as const, revisions: revisions + 1, issues },
  };
}

function answerDraft(state: GraphStateType): AnswerDraft {
  return {
    question: state.question,
    answer: state.answer,
    sourceContext: state.sourceContext,
    history: state.history,
    memory: memoryContext(state),
  };
}

const graph = new StateGraph(GraphState)
  .addNode("directAnswer", directAnswer)
  .addNode("listKnowledgeBase", listKnowledgeBase)
  .addNode("checkAmbiguity", checkAmbiguity)
  .addNode("askForClarification", askForClarification)
  .addNode("searchKnowledgeBase", searchKnowledgeBase)
  .addNode("answerFromKb", answerFromKb)
  .addNode("tryOwnKnowledge", tryOwnKnowledge)
  .addNode("webSearch", webSearch)
  .addNode("checkAnswer", checkAnswer)
  .addNode("reviseAnswer", reviseAnswerNode)
  .addConditionalEdges(START, routeEntry, {
    directAnswer: "directAnswer",
    checkAmbiguity: "checkAmbiguity",
    searchKnowledgeBase: "searchKnowledgeBase",
    listKnowledgeBase: "listKnowledgeBase",
  })
  .addEdge("listKnowledgeBase", END)
  .addEdge("directAnswer", "checkAnswer")
  .addConditionalEdges("checkAmbiguity", routeAfterAmbiguityCheck, {
    askForClarification: "askForClarification",
    searchKnowledgeBase: "searchKnowledgeBase",
  })
  .addEdge("askForClarification", "searchKnowledgeBase")
  .addConditionalEdges("searchKnowledgeBase", routeAfterKbSearch, {
    answerFromKb: "answerFromKb",
    tryOwnKnowledge: "tryOwnKnowledge",
  })
  .addConditionalEdges("answerFromKb", routeAfterKbAnswer, {
    tryOwnKnowledge: "tryOwnKnowledge",
    checkAnswer: "checkAnswer",
  })
  .addConditionalEdges("tryOwnKnowledge", routeAfterOwnKnowledge, {
    webSearch: "webSearch",
    checkAnswer: "checkAnswer",
  })
  .addEdge("webSearch", "checkAnswer")
  .addConditionalEdges("checkAnswer", routeAfterCheck, {
    reviseAnswer: "reviseAnswer",
    [END]: END,
  })
  .addEdge("reviseAnswer", "checkAnswer");

let compiledGraphPromise: ReturnType<typeof compileGraph> | null = null;

async function compileGraph() {
  return graph.compile({ checkpointer: await getCheckpointer() });
}

function getCompiledGraph() {
  if (!compiledGraphPromise) {
    compiledGraphPromise = compileGraph().catch((err) => {
      compiledGraphPromise = null;
      throw err;
    });
  }
  return compiledGraphPromise;
}

/** tokenUsage: every LLM call this run made, added up; null when the provider reported none. */
export type AgentResult =
  | { status: "completed"; answer: string; toolsUsed: string[]; guardrail: GuardrailOutcome; tokenUsage: TokenUsage | null }
  | { status: "interrupted"; threadId: string; interrupt: ClarificationInterrupt; tokenUsage: TokenUsage | null };

export class NoPausedRunError extends Error {}

export type TokenHandler = (text: string) => void;

const STREAMED_ANSWER_NODES: Record<string, string | null> = {
  directAnswer: null,
  answerFromKb: KB_NO_MATCH_MARKER,
  tryOwnKnowledge: CANNOT_ANSWER_MARKER,
  webSearch: null,
};

function createTokenForwarder(onToken: TokenHandler, onSwitch?: () => void) {
  let currentNode: string | undefined;
  let held = "";
  let releasing = false;

  return (node: string, text: string) => {
    if (!(node in STREAMED_ANSWER_NODES) || !text) return;
    const marker = STREAMED_ANSWER_NODES[node];

    if (node !== currentNode) {
      if (currentNode !== undefined && releasing) onSwitch?.(); // the previous step's text was shown
      currentNode = node;
      held = "";
      releasing = marker === null;
    }

    if (releasing) {
      onToken(text);
      return;
    }

    held += text;
    if (!marker!.startsWith(held.trim())) {
      releasing = true;
      onToken(held);
      held = "";
    }
  };
}

export type AgentStatus = "CHECKING_ANSWER" | "IMPROVING_ANSWER" | "CREATING_FILE";
export type StatusHandler = (status: AgentStatus) => void;

/** Live updates while the agent answers. onReset: discard the text streamed so far. */
export interface AgentCallbacks {
  onToken?: TokenHandler;
  onStatus?: StatusHandler;
  onReset?: () => void;
}

function statusAfter(update: Record<string, unknown>): AgentStatus | null {
  for (const [node, value] of Object.entries(update)) {
    const changes = (value ?? {}) as Partial<GraphStateType>;
    if (node === "checkAnswer") {
      if (changes.guardrail?.status === "pending") return "IMPROVING_ANSWER";
    } else if (node === "reviseAnswer") {
      return "CHECKING_ANSWER";
    } else if (node in STREAMED_ANSWER_NODES && changes.answer !== STREAMED_ANSWER_NODES[node]) {
      return "CHECKING_ANSWER";
    }
  }
  return null;
}

export interface AgentTrace extends TraceContext {
  runId?: string;
}

async function runGraph(
  input: Parameters<Awaited<ReturnType<typeof compileGraph>>["stream"]>[0],
  threadId: string,
  { onToken, onStatus, onReset }: AgentCallbacks,
  { runId, ...trace }: AgentTrace = {},
  resumed = false
): Promise<AgentResult> {
  const app = await getCompiledGraph();
  const config = { configurable: { thread_id: threadId } };
  const traced = {
    ...traceConfig("chat_turn", { ...trace, agent_thread_id: threadId, guardrails: env.guardrailsEnabled }, [
      "chat",
      resumed ? "resume-clarification" : "new-question",
    ]),
    ...(runId ? { runId } : {}),
  };

  // The draft streams as it's written, even with guardrails on; the review runs afterwards and
  // most answers pass unchanged. If the reviewer asks for a revision, the draft is withdrawn at
  // once (onReset) and the approved answer is sent at the end.
  let streamed = "";
  const forward = onToken
    ? createTokenForwarder(
        (text) => {
          streamed += text;
          onToken(text);
        },
        () => {
          if (!streamed) return;
          streamed = "";
          onReset?.();
        }
      )
    : null;
  const usage = new TokenUsageTracker();
  const stream = await app.stream(input, {
    ...traced,
    ...config,
    callbacks: [usage],
    streamMode: ["messages", "updates"],
  });
  for await (const [mode, payload] of stream as AsyncIterable<[string, unknown]>) {
    if (mode === "messages") {
      const [chunk, metadata] = payload as [{ content: unknown }, { langgraph_node?: string }];
      forward?.(metadata.langgraph_node ?? "", extractText(chunk.content));
    } else if (mode === "updates" && env.guardrailsEnabled) {
      const status = statusAfter(payload as Record<string, unknown>);
      if (status === "IMPROVING_ANSWER" && streamed) {
        streamed = "";
        onReset?.();
      }
      if (status) onStatus?.(status);
    }
  }

  const snapshot = await app.getState(config);
  const pending = snapshot.tasks.flatMap((task) => task.interrupts);
  if (pending.length > 0) {
    return {
      status: "interrupted",
      threadId,
      interrupt: ClarificationInterruptSchema.parse(pending[0].value),
      tokenUsage: usage.total(),
    };
  }

  runInBackground("checkpoint cleanup", () => deleteAgentThread(threadId));
  const values = snapshot.values as GraphStateType;
  // Make sure the client ends up showing exactly the final answer (a revision, a withheld notice,
  // or a node that post-processed what it streamed).
  if (onToken && values.answer && values.answer.trim() !== streamed.trim()) {
    if (streamed) onReset?.();
    onToken(values.answer);
  }
  return {
    status: "completed",
    answer: values.answer,
    toolsUsed: values.guardrail.status === "withheld" ? [] : values.toolsUsed,
    guardrail: values.guardrail,
    tokenUsage: usage.total(),
  };
}

export async function askAgent(
  question: string,
  memory: {
    userId: string;
    userName?: string;
    /** The user asked for the reply as a downloadable file in this format. */
    outputFile?: "pdf" | "docx";
    history: ChatHistoryMessage[];
    summary: string;
    pastConversations?: string;
    attachedImages?: string;
    attachedDocuments?: string;
    documentOverview?: string;
    hasAttachments?: boolean;
    /** The user's knowledge-base document IDs, if already fetched (saves a lookup mid-answer). */
    knowledgeBaseDocumentIds?: string[];
  },
  callbacks: AgentCallbacks = {},
  trace?: AgentTrace
): Promise<AgentResult> {
  return runGraph(
    {
      question,
      history: memory.history,
      conversationSummary: memory.summary,
      pastConversations: memory.pastConversations ?? "",
      userName: memory.userName ?? "",
      outputFile: memory.outputFile ?? "",
      attachedImages: memory.attachedImages ?? "",
      attachedDocuments: memory.attachedDocuments ?? "",
      documentOverview: memory.documentOverview ?? "",
      hasAttachments: memory.hasAttachments ?? false,
      kbDocumentIds: memory.knowledgeBaseDocumentIds ?? null,
      userId: memory.userId,
      clarification: "",
      kbChunks: [],
      answer: "",
      toolsUsed: [],
      sourceContext: "",
      guardrail: { status: "pending", revisions: 0, issues: [] },
    },
    randomUUID(),
    callbacks,
    { userId: memory.userId, ...trace }
  );
}

export async function resumeAgent(
  threadId: string,
  reply: string,
  callbacks: AgentCallbacks = {},
  trace?: AgentTrace
): Promise<AgentResult> {
  const app = await getCompiledGraph();
  const snapshot = await app.getState({ configurable: { thread_id: threadId } });
  const isPaused = snapshot.tasks.some((task) => task.interrupts.length > 0);
  if (!isPaused) throw new NoPausedRunError(`No paused agent run for thread ${threadId}`);

  return runGraph(new Command({ resume: reply }), threadId, callbacks, trace, true);
}