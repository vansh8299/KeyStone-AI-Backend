import gql from "graphql-tag";

export const documentTypeDefs = gql`
  "Ingestion runs in the background after an upload; only READY documents are searched."
  enum DocumentStatus {
    PROCESSING
    READY
    FAILED
  }

  "A document in the signed-in user's knowledge base (add with ingestFile / ingestText)."
  type Document {
    id: ID!
    title: String!
    sourceUrl: String
    mongoDocId: String
    "SHA-256 (hex) of the ingested content; null for documents added before duplicate detection."
    contentHash: String
    status: DocumentStatus!
    "Why ingestion failed, when status is FAILED (safe to show). Uploading the file again retries."
    error: String
    "READY, but some pages (scans or images) couldn't be read, and why (e.g. the AI provider's rate limit). Uploading again retries."
    warning: String
    "Chunks stored for search, once READY."
    chunkCount: Int
    "Which loader processed it: pdf, convertible (converted to PDF first) or structured."
    pipeline: String
    createdAt: DateTime!
  }

  extend type Query {
    "Your knowledge-base documents, newest first."
    documents: [Document!]!
    "One of your documents; null if it doesn't exist or isn't yours."
    document(id: ID!): Document
  }
`;
