import { PrismaClient } from "@prisma/client";
import { env } from "../config/env";

declare global {
  var __prisma: PrismaClient | undefined;
}

export const prisma =
  global.__prisma ??
  new PrismaClient({
    log: env.nodeEnv === "development" ? ["error", "warn"] : ["error"],
  });

if (!env.isProd) {
  global.__prisma = prisma;
}
