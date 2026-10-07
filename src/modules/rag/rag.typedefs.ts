import gql from "graphql-tag";

export const ragTypeDefs = gql`
  scalar Upload

  type RetrievedChunk {
    documentId: String!
    title: String!
    sourceUrl: String
    text: String!
    score: Float!
  }

  "The queued document (status PROCESSING); poll documents / document(id) for the outcome."
  type IngestResult {
    document: Document!
    chunkCount: Int @deprecated(reason: "Ingestion is queued; read Document.chunkCount once READY.")
    pipeline: String @deprecated(reason: "Ingestion is queued; read Document.pipeline once READY.")
  }

  type AgentAnswer {
    answer: String!
    toolsUsed: [String!]!
    conversationId: ID!
    """
    True when the agent paused (human in the loop) and \`answer\` is a clarifying question.
    The user's next askAgent message in this conversation resumes the paused run.
    """
    needsHumanInput: Boolean!
    "The user message of this turn (the existing one when regenerating)."
    userMessageId: ID!
    "The saved assistant reply."
    assistantMessageId: ID!
    "PDF or Word files made for this reply, when the user asked for one. Download: GET /attachments/:id."
    files: [ResponseFile!]!
  }

  type ResponseFile {
    id: ID!
    filename: String!
    mimeType: String!
    size: Int!
    "The file's extension: pdf, docx, xlsx, pptx, csv, json, py, …"
    format: String!
  }

  enum AgentStreamEventType {
    "The conversation this turn belongs to is known (created for a new chat). Has conversationId."
    CONVERSATION
    "A piece of answer text, in order. Has text."
    TOKEN
    "Progress of the output guardrail review. Has status."
    STATUS
    "Discard the text received so far: the review rejected the draft, and the approved answer follows."
    RESET
    "The turn finished and the reply is saved. Has result (authoritative final answer)."
    DONE
  }

  enum AgentStatus {
    "The drafted answer (already streamed) is being reviewed."
    CHECKING_ANSWER
    "The review rejected the draft; it's being rewritten (then reviewed again)."
    IMPROVING_ANSWER
    "The answer is done and the PDF or Word file the user asked for is being made from it."
    CREATING_FILE
  }

  type AgentStreamEvent {
    type: AgentStreamEventType!
    conversationId: ID
    text: String
    status: AgentStatus
    result: AgentAnswer
  }

  input IngestTextInput {
    title: String!
    content: String!
    sourceUrl: String
  }

  extend type Query {
    "Semantic search over ingested documents via MongoDB Atlas Vector Search."
    searchDocuments(query: String!, topK: Int): [RetrievedChunk!]!
  }

  extend type Mutation {
    "Uploads and ingests a file (pdf, docx, doc, txt, md, rtf, xlsx, xls, csv)."
    ingestFile(file: Upload!, sourceUrl: String): IngestResult!

    "Ingests raw pasted text/markdown without a file upload."
    ingestText(input: IngestTextInput!): IngestResult!

    """
    Adds a public link to the knowledge base: a document (PDF, Word, Excel, CSV, text, Markdown),
    a Google Doc/Sheet/Slides or Google Drive/Dropbox/GitHub file, or a web page's text. Links that
    need signing in fail with "This link isn't publicly accessible."
    """
    ingestUrl(url: String!): IngestResult!

    deleteIngestedDocument(documentId: ID!): Boolean!

    """
    Asks the LangGraph agent a question — it decides whether to search the knowledge base, the
    web, or both. Pass conversationId to continue an existing conversation, or omit it to start
    a new one (the returned conversationId identifies it going forward).

    Branching: pass editMessageId to save the question as a new version of that user message, or
    regenerateMessageId (question not needed) to get a new version of that assistant reply. Both
    start a new branch; the previous one is kept and reachable with switchBranch.
    """
    askAgent(
      question: String
      conversationId: ID
      editMessageId: ID
      regenerateMessageId: ID
      "Files (images or documents) uploaded with uploadChatFile (max 4). When editing, omit to keep the original files."
      attachmentIds: [ID!]
    ): AgentAnswer!
  }

  extend type Subscription {
    """
    Same as askAgent, but streams the reply over WebSocket (graphql-ws): a CONVERSATION event,
    TOKEN events as the answer is generated, then DONE with the saved reply. Clarifying questions
    (human in the loop) arrive only in DONE, with no TOKEN events. With output guardrails on, the
    draft still streams as TOKEN events and is reviewed afterwards (STATUS); if the review rejects
    it, RESET withdraws the streamed text and the approved answer follows as TOKEN.
    """
    askAgentStream(
      question: String
      conversationId: ID
      editMessageId: ID
      regenerateMessageId: ID
      attachmentIds: [ID!]
    ): AgentStreamEvent!

    """
    Re-attaches to a reply that is still being generated in this conversation — e.g. after the
    client navigated away, reloaded, or lost its WebSocket mid-answer (the turn keeps running on
    the server either way). Sends CONVERSATION (a reply is in progress), the answer so far as one
    TOKEN (or the current STATUS), then the rest live, then DONE. Completes without events when no
    reply is in progress.
    """
    conversationTurn(conversationId: ID!): AgentStreamEvent!
  }
`;