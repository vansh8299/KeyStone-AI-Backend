# Keystone AI — Backend

A minimal Node.js/TypeScript GraphQL API using Apollo Server and Prisma, wired up for
a Neon serverless Postgres database.

> Note: this uses `provider = "postgresql"` in `prisma/schema.prisma`. Neon is
> Postgres-compatible, so you just point `DATABASE_URL` at your Neon connection
> string — no special Prisma provider is needed. (If you actually meant MongoDB,
> see the "Using MongoDB instead" section at the bottom — but note the schema as
> given uses `@db.Text`, which only exists on the Postgres/MySQL connectors, not Mongo.)

## Stack
- Express + `@apollo/server` (Apollo Server 4, standalone middleware)
- Prisma ORM
- Neon Postgres
- TypeScript

## Project structure
```
prisma/
  schema.prisma      # your data model (User, Conversation, Message, Document)
  seed.ts            # demo data seeder
src/
  index.ts           # server bootstrap
  prisma.ts          # Prisma client singleton
  context.ts         # GraphQL context (prisma + placeholder auth)
  graphql/
    typeDefs.ts      # GraphQL schema (SDL)
    resolvers.ts      # resolvers backed by Prisma
    scalars.ts        # DateTime / JSON custom scalars
```

## Setup

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Create a Neon database**
   - Sign up / log in at https://neon.tech
   - Create a project, then copy the connection string from the dashboard
     (Connection Details → make sure `sslmode=require` is included).

3. **Configure environment**
   ```bash
   cp .env.example .env
   ```
   Paste your Neon connection string into `DATABASE_URL`.

   > If your Neon connection string uses PgBouncer pooling (the default
   > "pooled connection" string), Prisma Migrate needs a *direct* (unpooled)
   > connection too. Add a `DIRECT_URL` env var with the non-pooled string and
   > add this to `prisma/schema.prisma`:
   > ```prisma
   > datasource db {
   >   provider  = "postgresql"
   >   url       = env("DATABASE_URL")
   >   directUrl = env("DIRECT_URL")
   > }
   > ```

4. **Run the first migration** (creates tables in Neon from the schema)
   ```bash
   npm run prisma:migrate -- --name init
   ```
   This also runs `prisma generate` automatically.

5. **(Optional) Seed demo data**
   ```bash
   npm run seed
   ```

6. **Start the dev server**
   ```bash
   npm run dev
   ```
   GraphQL endpoint: `http://localhost:4000/graphql`
   Health check: `http://localhost:4000/health`

## Example queries

Create a user:
```graphql
mutation {
  createUser(input: { email: "you@example.com", name: "You" }) {
    id
    email
  }
}
```

Start a conversation and add a message:
```graphql
mutation {
  createConversation(input: { userId: "USER_ID", title: "Test chat" }) {
    id
  }
}

mutation {
  createMessage(input: {
    conversationId: "CONVERSATION_ID"
    role: USER
    content: "Hello!"
  }) {
    id
    role
    content
  }
}
```

Fetch a conversation with its messages:
```graphql
query {
  conversation(id: "CONVERSATION_ID") {
    id
    title
    messages {
      role
      content
      createdAt
    }
  }
}
```

## LangSmith (tracing and feedback)

[LangSmith](https://smith.langchain.com) records every agent run: each LangGraph node, LLM call
(prompt, output, tokens, latency) and tool call (knowledge base search, web search, image reading).

1. Create an API key in LangSmith (Settings → API Keys).
2. In `.env`:
   ```
   LANGSMITH_TRACING=true
   LANGSMITH_API_KEY=lsv2_...
   LANGSMITH_PROJECT=keystone-ai       # traces go to this project (created on first trace)
   # LANGSMITH_ENDPOINT=https://eu.api.smith.langchain.com   # EU region / self-hosted only
   ```
3. Restart the server — it logs `LangSmith tracing on`.

What you get:
- **One `chat_turn` trace per question**, with the graph's nodes, LLM calls and tool calls nested
  inside. It is tagged `new-question` or `resume-clarification` and carries `user_id`,
  `conversation_id`, `user_message_id`, the LLM provider and whether guardrails are on.
- **Threads:** turns share `conversation_id`, so LangSmith's *Threads* tab shows each
  conversation's turns together.
- **User feedback:** 👍 / 👎 in the chat is sent as `user_rating` feedback on the turn that produced
  the answer (1 = like, 0 = dislike, with the chosen categories as the value and the reason as the
  comment). Changing or removing a rating updates or removes it. Only answers generated while
  tracing was on can be linked.
- **Background work** is traced as separate runs: `conversation_title`, `short_term_memory_summary`,
  `long_term_memory_summary`, `document_summary`, `pdf_page_ocr`.

Traces contain what users send (messages, attached files' text) and what the model answers, so
treat the LangSmith project as containing user data. Traces are uploaded in the background and
flushed on shutdown (SIGINT / SIGTERM); with tracing off nothing is sent.

## Production build
```bash
npm run build
npm start
```
Run `npm run prisma:deploy` (uses `prisma migrate deploy`) as part of your deploy
pipeline instead of `prisma:migrate`, since the latter is meant for local dev.

## Next steps
- Add authentication (JWT/session) and populate `context.userId` in `src/context.ts`.
- Add input validation on mutations.
- If you're building the RAG pipeline mentioned by `Document.mongoDocId` /
  `Message.metadata`, wire up your vector store (Mongo Atlas Vector Search, Pinecone,
  etc.) separately from this relational DB — this schema only stores the
  reference IDs, not the vectors/chunks themselves.

## Using MongoDB instead
If you do want the primary datastore to be MongoDB (not just the vector store),
you'd need to adjust the schema, since Prisma's Mongo connector:
- Uses `provider = "mongodb"` and requires `@map("_id") @db.ObjectId` on ids instead of `cuid()`-as-string (or keep string ids with `@default(auto()) @db.ObjectId`)
- Does not support `@db.Text` — drop that attribute (Mongo has no column-size limits)
- Does not support SQL-style relations the same way — relations work but there's no foreign-key enforcement at the DB level

Happy to generate that variant of the schema if that's actually what you meant by "noendb".
