import gql from "graphql-tag";

export const userTypeDefs = gql`
  type User {
    id: ID!
    email: String!
    name: String
    createdAt: DateTime!
    conversations: [Conversation!]!
  }

  type Query {
    "The signed-in user, or null when signed out."
    me: User
  }
`;