import gql from "graphql-tag";

export const userTypeDefs = gql`
  type User {
    id: ID!
    email: String!
    name: String
    createdAt: DateTime!
    """
    Your conversations, most recently active first, a page at a time: \`first\` (default and
    maximum 100) and \`after\` (the last conversation ID of the previous page).
    """
    conversations(first: Int, after: ID): [Conversation!]!
  }

  type Query {
    "The signed-in user, or null when signed out."
    me: User
  }
`;