import { GraphQLScalarType } from "graphql";
import { GraphQLContext, SubscriptionContext } from "../../context";
import { requireAuth } from "../../shared/requireAuth";
import { unauthenticatedError } from "../../shared/errors";
import { createRateLimiter } from "../../shared/rateLimit";
import { ingestService } from "./ingest.service";
import { documentService } from "../document/document.service";
import { runChatTurn, streamChatTurn, attachToChatTurn, AgentStreamEvent } from "./agentChat.service";
import { similaritySearchWithScore } from "./langchain/vectorStore";
import { getUploadScalar } from "../../lib/graphqlUpload";
import { parseInput } from "../../shared/validate";
import { badUserInputError } from "../../shared/errors";
import { limits } from "../../config/limits";
import { checkUploadFilename, readUploadLimited, type UploadPayload } from "../../shared/upload";
import { detectFileCategory } from "./loaders/fileType";
import {
  AskAgentArgsSchema,
  ConversationTurnArgsSchema,
  SearchDocumentsArgsSchema,
  IngestFileArgsSchema,
  IngestTextArgsSchema,
  DeleteIngestedDocumentArgsSchema,
} from "./rag.schemas";

const chatTurnLimiter = createRateLimiter({
  name: "chat-turn",
  limit: 30,
  windowMs: 5 * 60 * 1000,
  message: "You're sending messages very quickly. Please wait a few minutes and try again.",
});
const ingestLimiter = createRateLimiter({
  name: "ingest",
  limit: 20,
  windowMs: 10 * 60 * 1000,
  message: "You've added a lot to the knowledge base in a short time. Please wait a few minutes.",
});
const searchLimiter = createRateLimiter({
  name: "search",
  limit: 60,
  windowMs: 60 * 1000,
  message: "Too many searches. Please wait a moment and try again.",
});


export async function createRagController() {
  const Upload: GraphQLScalarType = await getUploadScalar();

  return {
    Upload,

    Query: {
      searchDocuments: async (_: unknown, args: unknown, ctx: GraphQLContext) => {
        const userId = requireAuth(ctx);
        await searchLimiter.consume(`user:${userId}`);
        const { query, topK } = parseInput(SearchDocumentsArgsSchema, args);
        const results = await similaritySearchWithScore(query, await documentService.idsForUser(userId), topK ?? 5);
        return results.map(({ document, score }) => ({
          documentId: document.metadata?.documentId,
          title: document.metadata?.title,
          sourceUrl: document.metadata?.sourceUrl,
          text: document.pageContent,
          score,
        }));
      },
    },

    Mutation: {
      ingestFile: async (
        _: unknown,
        { file, ...args }: { file: Promise<UploadPayload> },
        ctx: GraphQLContext
      ) => {
        const userId = requireAuth(ctx);
        await ingestLimiter.consume(`user:${userId}`);
        const { sourceUrl } = parseInput(IngestFileArgsSchema, args);
        const upload = await file;
        const filename = checkUploadFilename(upload.filename);
        if (detectFileCategory(filename) === "unsupported") {
          upload.createReadStream().destroy?.();
          throw badUserInputError(
            `Unsupported file type for "${filename}". Supported: pdf, docx, doc, txt, md, rtf, xlsx, xls, csv.`,
            { field: "file" }
          );
        }
        const buffer = await readUploadLimited(upload.createReadStream(), limits.ingestFileMaxBytes);
        return ingestService.ingestFile({ userId, filename, buffer, sourceUrl });
      },

      ingestText: async (_: unknown, args: unknown, ctx: GraphQLContext) => {
        const userId = requireAuth(ctx);
        await ingestLimiter.consume(`user:${userId}`);
        const { input } = parseInput(IngestTextArgsSchema, args);
        return ingestService.ingestText({ ...input, userId });
      },

      deleteIngestedDocument: (_: unknown, args: unknown, ctx: GraphQLContext) => {
        const userId = requireAuth(ctx);
        const { documentId } = parseInput(DeleteIngestedDocumentArgsSchema, args);
        return ingestService.deleteIngested(documentId, userId);
      },

      askAgent: async (_: unknown, args: unknown, ctx: GraphQLContext) => {
        const userId = requireAuth(ctx);
        await chatTurnLimiter.consume(`user:${userId}`);
        return runChatTurn({ userId, ...parseInput(AskAgentArgsSchema, args) });
      },
    },

    Subscription: {
      askAgentStream: {
        subscribe: async (_: unknown, args: unknown, ctx: SubscriptionContext) => {
          if (!ctx.userId) throw unauthenticatedError();
          await chatTurnLimiter.consume(`user:${ctx.userId}`);
          return streamChatTurn({ userId: ctx.userId, ...parseInput(AskAgentArgsSchema, args) });
        },
        resolve: (event: AgentStreamEvent) => event,
      },
      conversationTurn: {
        subscribe: (_: unknown, args: unknown, ctx: SubscriptionContext) => {
          if (!ctx.userId) throw unauthenticatedError();
          const { conversationId } = parseInput(ConversationTurnArgsSchema, args);
          return attachToChatTurn(ctx.userId, conversationId);
        },
        resolve: (event: AgentStreamEvent) => event,
      },
    },
  };
}
