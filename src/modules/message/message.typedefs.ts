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

  "Tokens used to produce an assistant reply, across every LLM call of that turn."
  type TokenUsage {
    inputTokens: Int!
    outputTokens: Int!
    totalTokens: Int!
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
    "Null for user messages, and for replies saved before usage was recorded or whose provider reported none."
    tokenUsage: TokenUsage
    createdAt: DateTime!
  }

  extend type Query {
    "Every message of one of your conversations, on all branches, oldest first."
    messages(conversationId: ID!): [Message!]!
  }
`;