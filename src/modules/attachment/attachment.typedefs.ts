import gql from "graphql-tag";

export const attachmentTypeDefs = gql`
  enum AttachmentKind {
    image
    document
  }

  "A file uploaded for a chat message, already read so the assistant can use it."
  type ChatAttachment {
    id: ID!
    kind: AttachmentKind!
    filename: String!
    mimeType: String!
    size: Int!
    "Images: what the image shows plus any text in it, as the assistant will see it."
    parsedText: String
    "Documents: a summary of the document."
    summary: String
    "Documents: pages (PDF) or sheets (spreadsheets)."
    pageCount: Int
    createdAt: DateTime!
  }

  extend type Mutation {
    """
    Uploads and reads a file to attach to a chat message: an image (PNG, JPEG, WebP, GIF; up to
    5 MB) or a document (PDF, Word .docx, Excel .xlsx/.xls, CSV, .txt, Markdown; up to 20 MB).
    Pass the returned id in askAgent / askAgentStream attachmentIds when sending the message.
    """
    uploadChatFile(file: Upload!): ChatAttachment!
  }
`;
