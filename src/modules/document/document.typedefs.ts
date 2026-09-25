import gql from "graphql-tag";

export const documentTypeDefs = gql`
  "A document in the signed-in user's knowledge base (add with ingestFile / ingestText)."
  type Document {
    id: ID!
    title: String!
    sourceUrl: String
    mongoDocId: String
    "SHA-256 (hex) of the ingested content; null for documents added before duplicate detection."
    contentHash: String
    createdAt: DateTime!
  }

  extend type Query {
    "Your knowledge-base documents, newest first."
    documents: [Document!]!
    "One of your documents; null if it doesn't exist or isn't yours."
    document(id: ID!): Document
  }
`;
