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
  /** Embedded images with a side at or below this many pixels are decoration (icons, logos, rules). */
  pdfImageMinPx: 120,
  /** Knowledge-base ingestion runs in the background, so it may read more pages with the vision model. */
  ingestPdfVisionMaxPages: 100,
  /** On a rate limit (429) the pages of a file pause for the provider's suggested delay, then retry. */
  pdfRateLimitMaxRetries: 4,
  pdfRateLimitDefaultWaitMs: 30_000, // when the provider doesn't say how long
  /** Total pausing allowed per file: chat uploads are waited on by the user; ingestion runs in the background. */
  pdfRateLimitWaitBudgetMs: 90_000,
  ingestPdfRateLimitWaitBudgetMs: 10 * 60_000,

  // Reading documents from links (linkFetcher.ts).
  linkFetchTimeoutMs: 30_000,
  linkMaxRedirects: 5,
  /** A web page with less readable text than this is treated as needing JavaScript. */
  linkPageMinTextChars: 200,

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
  /** Dropped database connections in a row (e.g. a sleeping serverless database) before it's logged as an error. */
  ingestionConnectionErrorsBeforeAlert: 4,

  guardrailMaxRevisions: 2,
  guardrailAnswerMaxChars: 8_000,

  answerMaxTokens: env.llmMaxOutputTokens,
  /** Replies that become a PDF or Word file are whole documents, so they may run much longer. */
  documentAnswerMaxTokens: Math.max(env.llmMaxOutputTokens, 8_192),
  classifyMaxTokens: 10,
  fileRequestMaxTokens: 60,
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
