import { env } from "../config/env";
import { prisma } from "../lib/prisma";
import { getMongoDb, closeMongo } from "../lib/mongo";

const DOCUMENT_ID_PATHS = ["documentId", "metadata.documentId"] as const;

async function main() {
  const apply = process.argv.includes("--apply");
  const db = await getMongoDb();
  const collection = db.collection(env.mongodbCollection);

  const chunkDocumentIds = new Set<string>();
  for (const path of DOCUMENT_ID_PATHS) {
    const ids = await collection.distinct(path);
    for (const id of ids) {
      if (typeof id === "string" && id) chunkDocumentIds.add(id);
    }
  }

  const existing = await prisma.document.findMany({
    where: { id: { in: [...chunkDocumentIds] } },
    select: { id: true },
  });
  const existingIds = new Set(existing.map((d) => d.id));
  const orphanIds = [...chunkDocumentIds].filter((id) => !existingIds.has(id));

  const orphanFilter = {
    $or: DOCUMENT_ID_PATHS.map((path) => ({ [path]: { $in: orphanIds } })),
  };
  const noIdFilter = {
    $and: DOCUMENT_ID_PATHS.map((path) => ({ [path]: { $in: [null, ""] } })),
  };

  const [totalChunks, orphanChunks, chunksWithoutId] = await Promise.all([
    collection.countDocuments(),
    orphanIds.length ? collection.countDocuments(orphanFilter) : Promise.resolve(0),
    collection.countDocuments(noIdFilter),
  ]);

  console.log(`Collection:              ${env.mongodbDbName}.${env.mongodbCollection}`);
  console.log(`Total chunks:            ${totalChunks}`);
  console.log(`Documents with chunks:   ${chunkDocumentIds.size}`);
  console.log(`Orphaned documents:      ${orphanIds.length}`);
  console.log(`Orphaned chunks:         ${orphanChunks}`);
  if (chunksWithoutId > 0) {
    console.log(`Chunks with no documentId (left untouched): ${chunksWithoutId}`);
  }

  if (orphanIds.length === 0) {
    console.log("\nNothing to clean up.");
    return;
  }

  for (const id of orphanIds) {
    const title = (await collection.findOne(
      { $or: DOCUMENT_ID_PATHS.map((path) => ({ [path]: id })) },
      { projection: { title: 1, "metadata.title": 1 } }
    )) as { title?: string; metadata?: { title?: string } } | null;
    console.log(`  - ${id}  ${title?.title ?? title?.metadata?.title ?? ""}`);
  }

  if (!apply) {
    console.log("\nDry run — nothing deleted. Re-run with --apply to delete these chunks.");
    return;
  }

  const result = await collection.deleteMany(orphanFilter);
  console.log(`\nDeleted ${result.deletedCount} orphaned chunks.`);
}

main()
  .catch((err) => {
    console.error("Cleanup failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeMongo();
    await prisma.$disconnect();
  });
