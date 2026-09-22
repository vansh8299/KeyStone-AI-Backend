import { Embeddings, EmbeddingsParams } from "@langchain/core/embeddings";
import { getEmbeddingProvider } from "../embeddings";

export class AppEmbeddings extends Embeddings {
  constructor(params: EmbeddingsParams = {}) {
    super(params);
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    const provider = getEmbeddingProvider();
    return provider.embedMany(texts);
  }

  async embedQuery(text: string): Promise<number[]> {
    const provider = getEmbeddingProvider();
    return provider.embed(text);
  }
}
