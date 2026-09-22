-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN "activeLeafId" TEXT;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN "parentId" TEXT;

-- CreateIndex
CREATE INDEX "Message_parentId_idx" ON "Message"("parentId");

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: existing conversations are linear, so each message's parent is the previous one.
UPDATE "Message" m
SET "parentId" = ordered.prev_id
FROM (
  SELECT "id", LAG("id") OVER (PARTITION BY "conversationId" ORDER BY "createdAt", "id") AS prev_id
  FROM "Message"
) ordered
WHERE m."id" = ordered."id";

-- Backfill: the active leaf is each conversation's latest message.
UPDATE "Conversation" c
SET "activeLeafId" = (
  SELECT m."id" FROM "Message" m
  WHERE m."conversationId" = c."id"
  ORDER BY m."createdAt" DESC, m."id" DESC
  LIMIT 1
);
