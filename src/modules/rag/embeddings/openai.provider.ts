import OpenAI from "openai";
import { env } from "../../../config/env";
import { EmbeddingProvider } from "./embedding.types";

const MODEL_DIMENSIONS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
};

export function createOpenAIEmbeddingProvider(): EmbeddingProvider {
  if (!env.openaiApiKey) {
    throw new Error("OPENAI_API_KEY is required when EMBEDDING_PROVIDER=openai");
  }

  const client = new OpenAI({ apiKey: env.openaiApiKey });
  const model = env.openaiEmbeddingModel;
  const dimensions = MODEL_DIMENSIONS[model] ?? 1536;

  return {
    id: `openai:${model}`,
    dimensions,

    async embed(text: string) {
      const res = await client.embeddings.create({ model, input: text });
      return res.data[0].embedding;
    },

    async embedMany(texts: string[]) {
      if (texts.length === 0) return [];
      const res = await client.embeddings.create({ model, input: texts });
      return res.data.map((d) => d.embedding);
    },
  };
}