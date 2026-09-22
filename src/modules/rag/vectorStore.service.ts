import { ObjectId } from "mongodb";
import { env } from "../../config/env";
import { getMongoDb } from "../../lib/mongo";
import { getEmbeddingProvider } from "./embeddings";

export interface DocumentChunk {
  _id?: ObjectId;
  documentId: string;
  title: string;
  sourceUrl?: string;
  chunkIndex: number;
  text: string;
  embedding: number[];
  embeddingProvider: string;
  createdAt: Date;
}

export interface RetrievedChunk {
  documentId: string;
  title: string;
  sourceUrl?: string;
  text: string;
  score: number;
}

async function getCollection() {
  const db = await getMongoDb();
  return db.collection<DocumentChunk>(env.mongodbCollection);
}

export const vectorStoreService = {
  async insertChunks(chunks: Omit<DocumentChunk, "_id" | "createdAt">[]): Promise<void> {
    if (chunks.length === 0) return;
    const collection = await getCollection();
    await collection.insertMany(chunks.map((c) => ({ ...c, createdAt: new Date() })));
  },

  async deleteByDocumentId(documentId: string): Promise<void> {
    const collection = await getCollection();
    await collection.deleteMany({ documentId });
  },

  async similaritySearch(query: string, topK = 5): Promise<RetrievedChunk[]> {
    const provider = getEmbeddingProvider();
    const queryEmbedding = await provider.embed(query);
    const collection = await getCollection();

    const results = await collection
      .aggregate<DocumentChunk & { score: number }>([
        {
          $vectorSearch: {
            index: env.mongodbVectorIndex,
            path: "embedding",
            queryVector: queryEmbedding,
            numCandidates: Math.max(topK * 10, 100),
            limit: topK,
          },
        },
        {
          $project: {
            documentId: 1,
            title: 1,
            sourceUrl: 1,
            text: 1,
            score: { $meta: "vectorSearchScore" },
          },
        },
      ])
      .toArray();

    return results.map((r) => ({
      documentId: r.documentId,
      title: r.title,
      sourceUrl: r.sourceUrl,
      text: r.text,
      score: r.score,
    }));
  },
};
