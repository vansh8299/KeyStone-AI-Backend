import gql from "graphql-tag";

export const messageTypeDefs = gql`
  enum MessageRole {
    USER
    ASSISTANT
    SYSTEM
  }

  enum MessageSource {
    RAG
    WEB_SEARCH
    HYBRID
    NONE
  }

  type Message {
    id: ID!
    conversationId: String!
    conversation: Conversation!
    "Previous message in the tree; null for the first message of a branch root."
    parentId: ID
    "Ids of all versions of this message (same parent), oldest first, including this one."
    siblingIds: [ID!]!
    role: MessageRole!
    content: String!
    source: MessageSource
    metadata: JSON
    createdAt: DateTime!
  }

  extend type Query {
    "Every message of one of your conversations, on all branches, oldest first."
    messages(conversationId: ID!): [Message!]!
  }
`;