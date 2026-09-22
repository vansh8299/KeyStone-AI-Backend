-- Long-term memory switches from extracted facts (Memory table) to referencing chat history:
-- each conversation keeps a short summary that the assistant sees in the user's other chats.

-- DropForeignKey
ALTER TABLE "Memory" DROP CONSTRAINT "Memory_userId_fkey";

-- DropTable
DROP TABLE "Memory";

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "historySummary" TEXT,
ADD COLUMN     "historySummaryEmbedding" DOUBLE PRECISION[],
ADD COLUMN     "historySummaryMessages" INTEGER NOT NULL DEFAULT 0;
