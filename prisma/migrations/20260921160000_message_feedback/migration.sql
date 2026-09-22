-- CreateEnum
CREATE TYPE "FeedbackRating" AS ENUM ('LIKE', 'DISLIKE');

-- CreateTable
CREATE TABLE "MessageFeedback" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rating" "FeedbackRating" NOT NULL,
    "categories" TEXT[],
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessageFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MessageFeedback_messageId_key" ON "MessageFeedback"("messageId");

-- CreateIndex
CREATE INDEX "MessageFeedback_userId_idx" ON "MessageFeedback"("userId");

-- CreateIndex
CREATE INDEX "MessageFeedback_rating_idx" ON "MessageFeedback"("rating");

-- AddForeignKey
ALTER TABLE "MessageFeedback" ADD CONSTRAINT "MessageFeedback_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageFeedback" ADD CONSTRAINT "MessageFeedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

