import { env } from "./env";

export const limits = {
  questionMaxChars: env.maxQuestionChars,
  searchQueryMaxChars: 1000,
  searchTopKMax: 20,
  ingestTitleMaxChars: 200,
  conversationTitleMaxChars: 200,
  ingestTextMaxChars: 200_000,
  nameMaxChars: 100,
  feedbackReasonMaxChars: 2000,
  emailMaxChars: 254,
  passwordMinChars: 8,
  passwordMaxBytes: 72,
  otpLength: 6,
  otpTtlMs: 10 * 60 * 1000,
  otpMaxAttempts: 5,
  otpResendCooldownMs: 60 * 1000,
  ingestFileMaxBytes: 25 * 1024 * 1024,

  kbContextMaxChars: 16_000,
  webResultsMaxChars: 12_000,

  recentMaxMessages: 20,
  recentMaxChars: 12_000,
  recentKeepMessages: 10,
  recentKeepChars: 6_000,
  summaryBatchMaxMessages: 30,
  summaryBatchMaxChars: 24_000,

  pastChatsRecent: 3,
  pastChatsRelated: 3,
  pastChatsCandidates: 100,
  pastChatsRankingTimeoutMs: 2_000,
  pastChatSummaryFirstAt: 2,
  pastChatSummaryEvery: 6,
  pastChatSummaryInputChars: 12_000,

  chatImageMaxBytes: 5 * 1024 * 1024,
  chatImagesPerMessage: 4,
  imageParsedTextMaxChars: 8_000,
  unsentAttachmentTtlMs: 24 * 60 * 60 * 1000,

  chatDocumentMaxBytes: 20 * 1024 * 1024,
  documentTextMaxChars: 1_000_000,
  documentFullTextMaxChars: 24_000,
  documentChunkSize: 1_500,
  documentChunkOverlap: 200,
  documentSummaryInputChars: 200_000,
  documentChunksPerQuestion: 8,
  documentContextMaxChars: 40_000,
  documentsPerConversation: 10,
  pdfOcrMinTextChars: 25,
  pdfOcrMaxPages: 20,
  pdfOcrConcurrency: 3,
  pdfOcrRenderWidth: 1600,

  // External calls: fail in bounded time instead of hanging a reply. LangChain retries 6 times
  // with backoff by default, which turned a quota error into a minute of waiting.
  llmTimeoutMs: 90_000,
  llmMaxRetries: 2,
  embeddingTimeoutMs: 30_000,

  // Knowledge-base ingestion queue (ingestionQueue.ts).
  ingestionMaxAttempts: 3,
  ingestionRetryBaseMs: 30_000, // then 60 s, … (exponential)
  ingestionLeaseMs: 5 * 60_000, // renewed every third of this while a worker is on the job
  ingestionIdlePollMs: env.ingestionIdlePollMs,
  ingestionErrorBackoffMs: 15_000,

  guardrailMaxRevisions: 2,
  guardrailAnswerMaxChars: 8_000,

  answerMaxTokens: env.llmMaxOutputTokens,
  classifyMaxTokens: 10,
  ambiguityCheckMaxTokens: 300,
  rewriteMaxTokens: 200,
  titleMaxTokens: 30,
  summaryMaxTokens: 500,
  pastChatSummaryMaxTokens: 250,
  guardrailReviewMaxTokens: 300,
  imageParseMaxTokens: 1_500,
  documentSummaryMaxTokens: 700,
  pdfOcrPageMaxTokens: 2_500,
} as const;

export function clipText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…[truncated]` : text;
}
