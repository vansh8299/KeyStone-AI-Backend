import { valueFromASTUntyped, type FieldNode, type GraphQLResolveInfo } from "graphql";
import { GraphQLContext } from "../../context";
import { parseInput } from "../../shared/validate";
import { ConversationPageArgsSchema, type ConversationPage } from "../conversation/conversation.schemas";
import { userService } from "./user.service";

type ConversationList = Awaited<ReturnType<typeof userService.findConversations>>;

/** The `conversations` field selected directly on this field (fragments fall back to the field resolver). */
function conversationsField(info: GraphQLResolveInfo): FieldNode | undefined {
  for (const node of info.fieldNodes) {
    const field = node.selectionSet?.selections.find(
      (s): s is FieldNode => s.kind === "Field" && s.name.value === "conversations"
    );
    if (field) return field;
  }
  return undefined;
}

function pageArgs(field: FieldNode, info: GraphQLResolveInfo): ConversationPage {
  const raw = Object.fromEntries(
    (field.arguments ?? []).map((arg) => [arg.name.value, valueFromASTUntyped(arg.value, info.variableValues)])
  );
  return parseInput(ConversationPageArgsSchema, raw);
}

export const userController = {
  Query: {
    me: async (_: unknown, __: unknown, ctx: GraphQLContext, info: GraphQLResolveInfo) => {
      if (!ctx.userId) return null;
      // The sidebar asks for both on every page load: fetch them together rather than one after the other.
      const field = conversationsField(info);
      const page = field ? pageArgs(field, info) : null;
      const [user, conversations] = await Promise.all([
        userService.findById(ctx.userId),
        page ? userService.findConversations(ctx.userId, page) : undefined,
      ]);
      if (!user) return null;
      return conversations && page ? { ...user, prefetched: { page, conversations } } : user;
    },
  },

  User: {
    conversations: (
      parent: { id: string; prefetched?: { page: ConversationPage; conversations: ConversationList } },
      args: unknown
    ) => {
      const page = parseInput(ConversationPageArgsSchema, args);
      const prefetched = parent.prefetched;
      if (prefetched && prefetched.page.first === page.first && prefetched.page.after === page.after) {
        return prefetched.conversations;
      }
      return userService.findConversations(parent.id, page);
    },
  },
};
