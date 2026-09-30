-- Knowledge-base ingestion moves to a background job queue.

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('PROCESSING', 'READY', 'FAILED');

-- AlterTable: existing documents were ingested synchronously, so they're READY.
ALTER TABLE "Document" ADD COLUMN     "status" "DocumentStatus" NOT NULL DEFAULT 'READY',
ADD COLUMN     "error" TEXT,
ADD COLUMN     "chunkCount" INTEGER,
ADD COLUMN     "pipeline" TEXT;

-- CreateTable
CREATE TABLE "IngestionJob" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "data" BYTEA NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "runAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedUntil" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IngestionJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IngestionJob_documentId_key" ON "IngestionJob"("documentId");

-- CreateIndex
CREATE INDEX "IngestionJob_runAfter_createdAt_idx" ON "IngestionJob"("runAfter", "createdAt");

-- AddForeignKey
ALTER TABLE "IngestionJob" ADD CONSTRAINT "IngestionJob_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
