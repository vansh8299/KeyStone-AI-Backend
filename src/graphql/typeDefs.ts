import { rootTypeDefs } from "./root.typedefs";
import { authTypeDefs } from "../modules/auth/auth.typedefs";
import { userTypeDefs } from "../modules/user/user.typedefs";
import { conversationTypeDefs } from "../modules/conversation/conversation.typedefs";
import { messageTypeDefs } from "../modules/message/message.typedefs";
import { documentTypeDefs } from "../modules/document/document.typedefs";
import { ragTypeDefs } from "../modules/rag/rag.typedefs";
import { attachmentTypeDefs } from "../modules/attachment/attachment.typedefs";
import { feedbackTypeDefs } from "../modules/feedback/feedback.typedefs";

export const typeDefs = [
  rootTypeDefs,
  userTypeDefs,
  authTypeDefs,
  conversationTypeDefs,
  messageTypeDefs,
  documentTypeDefs,
  ragTypeDefs,
  attachmentTypeDefs,
  feedbackTypeDefs,
];
