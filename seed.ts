import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to seed the demo user (demo@example.com / password123) in production.");
  }
  const passwordHash = await bcrypt.hash("password123", 10);

  const user = await prisma.user.create({
    data: {
      email: "demo@example.com",
      name: "Demo User",
      password: passwordHash,
      conversations: {
        create: {
          title: "First conversation",
          messages: {
            create: [
              { role: "USER", content: "Hello, how does RAG work here?", source: "NONE" },
              {
                role: "ASSISTANT",
                content: "It retrieves relevant chunks from the vector store, then generates a grounded answer.",
                source: "RAG",
                metadata: { retrievedDocIds: [] },
              },
            ],
          },
        },
      },
    },
  });

  await prisma.document.create({
    data: {
      title: "Sample source document",
      sourceUrl: "https://example.com/doc",
      mongoDocId: "placeholder-mongo-id",
    },
  });

  console.log("Seeded database with demo user:", user.email, "(password: password123)");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
