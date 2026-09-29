import gql from "graphql-tag";

export const conversationTypeDefs = gql`
  type Conversation {
    id: ID!
    userId: String!
    user: User!
    title: String
    createdAt: DateTime!
    updatedAt: DateTime!
    "Messages on the branch currently shown (root to activeLeafId), oldest first."
    messages: [Message!]!
    "Last message of the branch currently shown; null when the conversation is empty."
    activeLeafId: ID
    "True when the conversation was rewound: later messages exist below activeLeafId."
    isRewound: Boolean!
  }

  input CreateConversationInput {
    title: String
  }

  extend type Query {
    "Your conversations, most recently active first; paged like User.conversations."
    conversations(first: Int, after: ID): [Conversation!]!
    "One of your conversations (NOT_FOUND if it doesn't exist or isn't yours)."
    conversation(id: ID!): Conversation
  }

  extend type Mutation {
    "Creates an empty conversation for the signed-in user."
    createConversation(input: CreateConversationInput): Conversation!
    deleteConversation(id: ID!): Boolean!

    """
    Generates a short title for the conversation from its first message using the LLM.
    Only runs once: if the conversation already has a title, it is returned unchanged.
    """
    generateConversationTitle(id: ID!): Conversation!

    """
    Shows the branch containing messageId (e.g. another version of an edited message), continuing
    down to where that branch was last left off.
    """
    switchBranch(conversationId: ID!, messageId: ID!): Conversation!

    """
    Time travel: shows the conversation as it was right after messageId. Nothing is deleted — the
    next message sent starts a new branch from this point, and switchBranch returns to later ones.
    """
    rewindConversation(conversationId: ID!, messageId: ID!): Conversation!
  }
`;