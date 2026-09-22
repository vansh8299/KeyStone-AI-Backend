import { MongoDBAtlasVectorSearch } from "@langchain/mongodb";
import { Document } from "@langchain/core/documents";
import { env } from "../../../config/env";
import { getMongoDb } from "../../../lib/mongo";
import { AppEmbeddings } from "./embeddings.adapter";

let cached: MongoDBAtlasVectorSearch | null = null;

export async function getVectorStore(): Promise<MongoDBAtlasVectorSearch> {
  if (cached) return cached;

  const db = await getMongoDb();
  const collection = db.collection(env.mongodbCollection);

  cached = new MongoDBAtlasVectorSearch(new AppEmbeddings(), {
    collection: collection as any,
    indexName: env.mongodbVectorIndex,
    textKey: "text",
    embeddingKey: "embedding",
  });

  return cached;
}

export async function addDocumentsToStore(documents: Document[]): Promise<void> {
  if (documents.length === 0) return;
  const store = await getVectorStore();
  await store.addDocuments(documents);
}

export async function deleteDocumentsByDocumentId(documentId: string): Promise<number> {
  const db = await getMongoDb();
  const result = await db.collection(env.mongodbCollection).deleteMany({
    $or: [{ documentId }, { "metadata.documentId": documentId }],
  });
  return result.deletedCount;
}

export async function similaritySearchWithScore(
  query: string,
  documentIds: string[],
  topK = 5
): Promise<Array<{ document: Document; score: number }>> {
  if (documentIds.length === 0) return [];
  const store = await getVectorStore();
  const results = await store.similaritySearchWithScore(query, topK, {
    preFilter: { documentId: { $in: documentIds } },
  });
  return results.map(([document, score]) => ({ document, score }));
}
