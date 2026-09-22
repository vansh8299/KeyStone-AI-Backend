import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatOpenAI } from "@langchain/openai";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatGroq } from "@langchain/groq";
import { env } from "../../../config/env";
import { limits } from "../../../config/limits";

const cache = new Map<string, BaseChatModel>();

function createModel(modelName: string, maxTokens: number): BaseChatModel {
  switch (env.llmProvider) {
    case "openai":
      if (!env.openaiApiKey) throw new Error("OPENAI_API_KEY is required when LLM_PROVIDER=openai");
      return new ChatOpenAI({ apiKey: env.openaiApiKey, model: modelName, temperature: 0.2, maxTokens });

    case "gemini":
      if (!env.geminiApiKey) throw new Error("GEMINI_API_KEY is required when LLM_PROVIDER=gemini");
      return new ChatGoogleGenerativeAI({
        apiKey: env.geminiApiKey,
        model: modelName,
        temperature: 0.2,
        maxOutputTokens: maxTokens,
      });

    case "groq":
      if (!env.groqApiKey) throw new Error("GROQ_API_KEY is required when LLM_PROVIDER=groq");
      return new ChatGroq({ apiKey: env.groqApiKey, model: modelName, temperature: 0.2, maxTokens });

    default:
      throw new Error(`Unsupported LLM_PROVIDER "${env.llmProvider}". Use "openai", "gemini", or "groq".`);
  }
}

function cached(modelName: string, maxTokens: number): BaseChatModel {
  const key = `${modelName}:${maxTokens}`;
  let model = cache.get(key);
  if (!model) {
    model = createModel(modelName, maxTokens);
    cache.set(key, model);
  }
  return model;
}

const CHAT_MODELS = {
  openai: () => env.openaiChatModel,
  gemini: () => env.geminiChatModel,
  groq: () => env.groqModel,
} as const;

export function getChatModel(maxTokens: number = limits.answerMaxTokens): BaseChatModel {
  return cached(CHAT_MODELS[env.llmProvider](), maxTokens);
}

const VISION_MODELS = {
  openai: () => env.openaiChatModel,
  gemini: () => env.geminiChatModel,
  groq: () => "meta-llama/llama-4-scout-17b-16e-instruct",
} as const;

export function getVisionModel(maxTokens: number = limits.imageParseMaxTokens): BaseChatModel {
  return cached(env.visionModel ?? VISION_MODELS[env.llmProvider](), maxTokens);
}
