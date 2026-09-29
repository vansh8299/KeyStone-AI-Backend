import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { similaritySearchWithScore } from "../vectorStore";
import { documentService } from "../../../document/document.service";

const ChunkTitleSchema = z.string().min(1).catch("Untitled");

export const KNOWLEDGE_BASE_TOOL_NAME = "search_documents";

export interface KnowledgeBaseChunk {
  text: string;
  title: string;
  score: number;
}

export function createKnowledgeBaseSearchTool() {
  return tool(
    async ({ query, topK, userId, documentIds: knownIds }): Promise<KnowledgeBaseChunk[]> => {
      const documentIds = knownIds ?? (await documentService.idsForUser(userId));
      const results = await similaritySearchWithScore(query, documentIds, topK ?? 5);
      return results.map(({ document, score }) => ({
        text: document.pageContent,
        title: ChunkTitleSchema.parse(document.metadata?.title),
        score,
      }));
    },
    {
      name: KNOWLEDGE_BASE_TOOL_NAME,
      description:
        "Searches the user's uploaded knowledge base documents for passages relevant to the query.",
      schema: z.object({
        query: z.string().describe("The search query"),
        topK: z.number().int().positive().optional().describe("Number of chunks to return"),
        userId: z.string().min(1).describe("Whose knowledge base to search (the signed-in user)"),
        documentIds: z
          .array(z.string())
          .optional()
          .describe("That user's document IDs, when the caller already has them (skips looking them up)"),
      }),
    }
  );
}
