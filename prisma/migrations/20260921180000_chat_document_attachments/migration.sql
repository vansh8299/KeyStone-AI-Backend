-- AlterTable
ALTER TABLE "Attachment" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'image',
ADD COLUMN     "pageCount" INTEGER,
ADD COLUMN     "summary" TEXT;

-- CreateTable
CREATE TABLE "AttachmentChunk" (
    "id" TEXT NOT NULL,
    "attachmentId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "location" TEXT,
    "text" TEXT NOT NULL,
    "embedding" DOUBLE PRECISION[],

    CONSTRAINT "AttachmentChunk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AttachmentChunk_attachmentId_idx" ON "AttachmentChunk"("attachmentId");

-- AddForeignKey
ALTER TABLE "AttachmentChunk" ADD CONSTRAINT "AttachmentChunk_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "Attachment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

