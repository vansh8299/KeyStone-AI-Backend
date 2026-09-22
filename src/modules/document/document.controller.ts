import { GraphQLContext } from "../../context";
import { requireAuth } from "../../shared/requireAuth";
import { documentService } from "./document.service";

export const documentController = {
  Query: {
    documents: (_: unknown, __: unknown, ctx: GraphQLContext) => {
      const userId = requireAuth(ctx);
      return documentService.findManyByUser(userId);
    },
    document: (_: unknown, { id }: { id: string }, ctx: GraphQLContext) => {
      const userId = requireAuth(ctx);
      return documentService.findOwned(id, userId);
    },
  },
};
