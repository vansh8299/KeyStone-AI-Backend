import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatOpenAI } from "@langchain/openai";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatGroq } from "@langchain/groq";
import { env } from "../../../config/env";
import { limits } from "../../../config/limits";

/** A chat model with this app's call defaults (timeout) bound; usable with invoke() and pipe(). */
export type ChatModel = ReturnType<BaseChatModel["withConfig"]>;

const cache = new Map<string, ChatModel>();
const rawCache = new Map<string, BaseChatModel>();

function createModel(modelName: string, maxTokens: number): BaseChatModel {
  const common = { model: modelName, temperature: 0.2, maxRetries: limits.llmMaxRetries };
  switch (env.llmProvider) {
    case "openai":
      if (!env.openaiApiKey) throw new Error("OPENAI_API_KEY is required when LLM_PROVIDER=openai");
      return new ChatOpenAI({ ...common, apiKey: env.openaiApiKey, maxTokens });

    case "gemini":
      if (!env.geminiApiKey) throw new Error("GEMINI_API_KEY is required when LLM_PROVIDER=gemini");
      return new ChatGoogleGenerativeAI({ ...common, apiKey: env.geminiApiKey, maxOutputTokens: maxTokens });

    case "groq":
      if (!env.groqApiKey) throw new Error("GROQ_API_KEY is required when LLM_PROVIDER=groq");
      return new ChatGroq({ ...common, apiKey: env.groqApiKey, maxTokens });

    default:
      throw new Error(`Unsupported LLM_PROVIDER "${env.llmProvider}". Use "openai", "gemini", or "groq".`);
  }
}

function rawModel(modelName: string, maxTokens: number): BaseChatModel {
  const key = `${modelName}:${maxTokens}`;
  let model = rawCache.get(key);
  if (!model) {
    model = createModel(modelName, maxTokens);
    rawCache.set(key, model);
  }
  return model;
}

function cached(modelName: string, maxTokens: number): ChatModel {
  const key = `${modelName}:${maxTokens}`;
  let model = cache.get(key);
  if (!model) {
    // Every call (including its retries) is aborted after llmTimeoutMs, for every provider.
    model = rawModel(modelName, maxTokens).withConfig({ timeout: limits.llmTimeoutMs });
    cache.set(key, model);
  }
  return model;
}

const CHAT_MODELS = {
  openai: () => env.openaiChatModel,
  gemini: () => env.geminiChatModel,
  groq: () => env.groqModel,
} as const;

export function getChatModel(maxTokens: number = limits.answerMaxTokens): ChatModel {
  return cached(CHAT_MODELS[env.llmProvider](), maxTokens);
}

/** The model that writes the answer: longer output when the reply becomes a PDF or Word file. */
export function getAnswerModel(outputFile?: string): ChatModel {
  return getChatModel(outputFile ? limits.documentAnswerMaxTokens : limits.answerMaxTokens);
}

const VISION_MODELS = {
  openai: () => env.openaiChatModel,
  gemini: () => env.geminiChatModel,
  groq: () => "meta-llama/llama-4-scout-17b-16e-instruct",
} as const;

/**
 * The vision model itself (it's used with withStructuredOutput, which a bound model lacks); its
 * callers set `timeout: limits.llmTimeoutMs` on their chains, which reaches this call.
 */
export function getVisionModel(maxTokens: number = limits.imageParseMaxTokens): BaseChatModel {
  return rawModel(env.visionModel ?? VISION_MODELS[env.llmProvider](), maxTokens);
}
