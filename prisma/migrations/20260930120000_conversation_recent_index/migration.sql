-- One index for "a user's conversations, most recent first" (paged sidebar, long-term memory),
-- replacing the plain userId index it makes redundant.

-- DropIndex
DROP INDEX "Conversation_userId_idx";

-- CreateIndex
CREATE INDEX "Conversation_userId_updatedAt_id_idx" ON "Conversation"("userId", "updatedAt" DESC, "id" DESC);
