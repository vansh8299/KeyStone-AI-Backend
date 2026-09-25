import { GraphQLContext } from "../../context";
import { requireAuth } from "../../shared/requireAuth";
import { documentService } from "./document.service";
import { IdArgsSchema, parseInput } from "../../shared/validate";

export const documentController = {
  Query: {
    documents: (_: unknown, __: unknown, ctx: GraphQLContext) => {
      const userId = requireAuth(ctx);
      return documentService.findManyByUser(userId);
    },
    document: (_: unknown, args: unknown, ctx: GraphQLContext) => {
      const userId = requireAuth(ctx);
      const { id } = parseInput(IdArgsSchema, args);
      return documentService.findOwned(id, userId);
    },
  },
};
