import { GraphQLContext } from "../../context";
import { userService } from "./user.service";

export const userController = {
  Query: {
    me: (_: unknown, __: unknown, ctx: GraphQLContext) => {
      if (!ctx.userId) return null;
      return userService.findById(ctx.userId);
    },
  },

  User: {
    conversations: (parent: { id: string }) => userService.findConversations(parent.id),
  },
};