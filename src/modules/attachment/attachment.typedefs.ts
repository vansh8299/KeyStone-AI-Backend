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
    """
    Documents: pages the assistant couldn't fully read (scans or images), and why, e.g. the AI
    provider's rate limit. Only returned by uploadChatFile; null when everything was read.
    """
    warning: String
    createdAt: DateTime!
  }

  extend type Mutation {
    """
    Uploads and reads a file to attach to a chat message: an image (PNG, JPEG, WebP, GIF; up to
    5 MB) or a document (PDF, Word .docx, Excel .xlsx/.xls, CSV, .txt, Markdown; up to 20 MB).
    Pass the returned id in askAgent / askAgentStream attachmentIds when sending the message.
    """
    uploadChatFile(file: Upload!): ChatAttachment!

    """
    Reads a public link and attaches it like an uploaded file: a document (PDF, Word, Excel, CSV,
    text, Markdown), an image, a Google Doc/Sheet/Slides or Google Drive/Dropbox/GitHub file, or a
    web page's text. Links that need signing in fail with "This link isn't publicly accessible."
    """
    attachLink(url: String!): ChatAttachment!
  }
`;
