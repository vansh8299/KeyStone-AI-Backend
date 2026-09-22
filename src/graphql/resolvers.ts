import { DateTimeScalar, JSONScalar } from "./scalars";
import { authController } from "../modules/auth/auth.controller";
import { userController } from "../modules/user/user.controller";
import { conversationController } from "../modules/conversation/conversation.controller";
import { messageController } from "../modules/message/message.controller";
import { documentController } from "../modules/document/document.controller";
import { createRagController } from "../modules/rag/rag.controller";
import { attachmentController } from "../modules/attachment/attachment.controller";
import { feedbackController } from "../modules/feedback/feedback.controller";
import type { makeExecutableSchema } from "@graphql-tools/schema";
import { withAuthGuard } from "./authGuard";

type Resolvers = NonNullable<Parameters<typeof makeExecutableSchema>[0]["resolvers"]>;

const scalarResolvers = {
  DateTime: DateTimeScalar,
  JSON: JSONScalar,
};

export async function buildResolvers(): Promise<Resolvers> {
  const ragController = await createRagController();

  return withAuthGuard([
    scalarResolvers,
    userController,
    authController,
    conversationController,
    messageController,
    documentController,
    ragController,
    attachmentController,
    feedbackController,
  ]) as Resolvers;
}
