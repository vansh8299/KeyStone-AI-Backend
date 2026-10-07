import { PrismaClient } from "@prisma/client";
import { env } from "../config/env";
import { moduleLogger } from "./logger";

declare global {
  var __prisma: PrismaClient | undefined;
}

const log = moduleLogger("prisma");

/**
 * Serverless Postgres (e.g. Neon) closes idle connections while it sleeps; Prisma reconnects on the
 * next query, and callers that care handle the failed one. Not worth an error line each time.
 */
const CONNECTION_DROPPED = /server has closed the connection|can't reach database server|connection.*(closed|reset|terminated)/i;

function createClient() {
  const client = new PrismaClient({
    log: [
      { emit: "event", level: "error" },
      { emit: "event", level: "warn" },
    ],
  });
  client.$on("error", (e) => {
    if (CONNECTION_DROPPED.test(e.message)) log.debug({ target: e.target }, e.message.trim());
    else log.error({ target: e.target }, e.message.trim());
  });
  if (env.nodeEnv === "development") {
    client.$on("warn", (e) => log.warn({ target: e.target }, e.message.trim()));
  }
  return client;
}

export const prisma = global.__prisma ?? createClient();

if (!env.isProd) {
  global.__prisma = prisma;
}
