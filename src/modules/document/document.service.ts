import { prisma } from "../../lib/prisma";
import { notFoundError } from "../../shared/errors";

export const documentService = {
  findManyByUser(userId: string) {
    return prisma.document.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
  },

  findOwned(id: string, userId: string) {
    return prisma.document.findFirst({ where: { id, userId } });
  },

  async requireOwned(id: string, userId: string) {
    const document = await this.findOwned(id, userId);
    if (!document) throw notFoundError("This document doesn't exist or was deleted.");
    return document;
  },

  /** The user's searchable documents (READY; others have no chunks yet or failed). */
  async idsForUser(userId: string): Promise<string[]> {
    const rows = await prisma.document.findMany({ where: { userId, status: "READY" }, select: { id: true } });
    return rows.map((r) => r.id);
  },
};
