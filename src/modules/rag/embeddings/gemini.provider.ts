import { GoogleGenerativeAI } from "@google/generative-ai";
import { env } from "../../../config/env";
import { limits } from "../../../config/limits";
import { EmbeddingProvider } from "./embedding.types";

const MODEL_DIMENSIONS: Record<string, number> = {
  "text-embedding-004": 768,
  "embedding-001": 768,
};

export function createGeminiEmbeddingProvider(): EmbeddingProvider {
  if (!env.geminiApiKey) {
    throw new Error("GEMINI_API_KEY is required when EMBEDDING_PROVIDER=gemini");
  }

  const client = new GoogleGenerativeAI(env.geminiApiKey);
  const model = env.geminiEmbeddingModel;
  const genModel = client.getGenerativeModel({ model }, { timeout: limits.embeddingTimeoutMs });
  const dimensions = MODEL_DIMENSIONS[model] ?? 768;

  return {
    id: `gemini:${model}`,
    dimensions,

    async embed(text: string) {
      const res = await genModel.embedContent(text);
      return res.embedding.values;
    },

    async embedMany(texts: string[]) {
      if (texts.length === 0) return [];
      const res = await genModel.batchEmbedContents({
        requests: texts.map((text) => ({
          content: { role: "user", parts: [{ text }] },
        })),
      });
      return res.embeddings.map((e) => e.values);
    },
  };
}
