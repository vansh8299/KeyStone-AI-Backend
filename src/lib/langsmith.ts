import { createHash, randomUUID } from "crypto";
import { Client } from "langsmith";
import { awaitAllCallbacks } from "@langchain/core/callbacks/promises";
import type { RunnableConfig } from "@langchain/core/runnables";
import { env } from "../config/env";
import { moduleLogger } from "./logger";

const log = moduleLogger("langsmith");

let client: Client | null = null;
function getClient(): Client {
  client ??= new Client();
  return client;
}

export interface TraceContext {
  userId?: string;
  conversationId?: string;
  [key: string]: unknown;
}

export function traceConfig(runName: string, { userId, conversationId, ...rest }: TraceContext = {}, tags: string[] = []): RunnableConfig {
  return {
    runName,
    tags,
    metadata: {
      ...(userId ? { user_id: userId } : {}),
      ...(conversationId ? { conversation_id: conversationId } : {}),
      llm_provider: env.llmProvider,
      ...rest,
    },
  };
}

export function newTraceRunId(): string | undefined {
  return env.langsmith.enabled ? randomUUID() : undefined;
}

function feedbackIdFor(messageId: string): string {
  const hex = createHash("sha1").update(`message-feedback:${messageId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const FEEDBACK_KEY = "user_rating";

export const langsmithFeedback = {
  async sync(
    messageId: string,
    runId: string | undefined,
    feedback: { rating: "LIKE" | "DISLIKE"; categories: string[]; reason: string | null } | null
  ): Promise<void> {
    if (!env.langsmith.enabled || !runId) return;
    const feedbackId = feedbackIdFor(messageId);
    try {
      if (!feedback) {
        await getClient().deleteFeedback(feedbackId).catch(() => {});
        return;
      }
      const fields = {
        score: feedback.rating === "LIKE" ? 1 : 0,
        value: feedback.categories.length > 0 ? feedback.categories.join(",") : undefined,
        comment: feedback.reason ?? undefined,
      };
      try {
        await getClient().updateFeedback(feedbackId, fields);
      } catch {
        await getClient().createFeedback(runId, FEEDBACK_KEY, { ...fields, feedbackId, feedbackSourceType: "app" });
      }
    } catch (err) {
      log.warn({ err }, "LangSmith feedback sync failed");
    }
  },
};

export async function flushTraces(): Promise<void> {
  if (!env.langsmith.enabled) return;
  try {
    await awaitAllCallbacks();
  } catch (err) {
    log.warn({ err }, "flushing LangSmith traces failed");
  }
}
