import { env } from "../../../config/env";
import { EmbeddingProvider } from "./embedding.types";
import { createOpenAIEmbeddingProvider } from "./openai.provider";
import { createGeminiEmbeddingProvider } from "./gemini.provider";

let cached: EmbeddingProvider | null = null;

export function getEmbeddingProvider(): EmbeddingProvider {
  if (cached) return cached;

  switch (env.embeddingProvider) {
    case "openai":
      cached = createOpenAIEmbeddingProvider();
      break;
    case "gemini":
      cached = createGeminiEmbeddingProvider();
      break;
    default:
      throw new Error(
        `Unsupported EMBEDDING_PROVIDER "${env.embeddingProvider}". Use "openai" or "gemini".`
      );
  }

  return cached;
}
