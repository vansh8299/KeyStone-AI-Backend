import { randomUUID } from "crypto";
import express from "express";
import compression from "compression";
import cors from "cors";
import cookieParser from "cookie-parser";
import http from "http";
import { ApolloServer } from "@apollo/server";
import { expressMiddleware } from "@as-integrations/express5";
import { ApolloServerPluginDrainHttpServer } from "@apollo/server/plugin/drainHttpServer";

import { env, isAllowedOrigin } from "./config/env";
import { typeDefs } from "./graphql/typeDefs";
import { buildResolvers } from "./graphql/resolvers";
import { makeExecutableSchema } from "@graphql-tools/schema";
import { WebSocketServer } from "ws";
import { useServer } from "graphql-ws/use/ws";
import { createContext, createSubscriptionContext, GraphQLContext } from "./context";
import { prisma } from "./lib/prisma";
import { getGraphqlUploadExpress } from "./lib/graphqlUpload";
import { formatGraphQLError, formatGraphQLErrors } from "./shared/errorHandling";
import { errorHandler, notFoundHandler } from "./shared/httpMiddleware";
import { attachmentRouter } from "./modules/attachment/attachment.routes";
import { flushTraces } from "./lib/langsmith";
import { closeMongo, getMongoDb } from "./lib/mongo";
import { closeRedis, getRedis } from "./lib/redis";
import { drainBackground } from "./lib/backgroundTasks";
import { startIngestionWorker, stopIngestionWorker } from "./modules/rag/ingestionQueue";
import { startKeepAwake, stopKeepAwake } from "./lib/keepAwake";
import { validate as graphqlValidate, specifiedRules } from "graphql";
import { queryLimitsRule } from "./graphql/queryLimits";
import { operationLogPlugin } from "./graphql/operationLog";
import { moduleLogger, withRequestContext } from "./lib/logger";
import { envWarnings } from "./config/env";

const log = moduleLogger("server");
const httpLog = moduleLogger("http");
for (const warning of envWarnings) log.warn(warning);

const DEPENDENCY_CHECK_TIMEOUT_MS = 3_000;

function withTimeout(check: () => Promise<unknown>): Promise<"ok" | string> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    check().then(() => "ok" as const),
    new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve("timeout"), DEPENDENCY_CHECK_TIMEOUT_MS);
    }),
  ])
    .catch(() => "unreachable")
    .finally(() => clearTimeout(timer));
}

/** Pings each backing service; the result names only the state, never connection details. */
async function checkDependencies(): Promise<Record<string, string>> {
  const redis = getRedis();
  const [postgres, mongodb, redisState] = await Promise.all([
    withTimeout(() => prisma.$queryRaw`SELECT 1`),
    withTimeout(async () => (await getMongoDb()).command({ ping: 1 })),
    redis ? withTimeout(() => redis.ping()) : Promise.resolve("not configured"),
  ]);
  return { postgres, mongodb, ...(redis ? { redis: redisState } : {}) };
}

/** Set once the server is running; stops it (draining HTTP requests and closing WebSockets). */
let stopServer: (() => Promise<void>) | null = null;

async function main() {
  const app = express();
  const httpServer = http.createServer(app);

  if (env.trustProxy > 0) app.set("trust proxy", env.trustProxy);
  app.disable("x-powered-by");
  // A request ID for correlating logs: kept from the caller (e.g. a load balancer) if it looks
  // sane, otherwise generated; echoed back so a user's report can be matched to the logs. Every
  // log line written while handling the request carries it, and one access-log line closes it.
  app.use((req, res, next) => {
    const incoming = req.get("x-request-id");
    const requestId = incoming && /^[A-Za-z0-9._-]{8,128}$/.test(incoming) ? incoming : randomUUID();
    res.locals.requestId = requestId;
    res.set("X-Request-Id", requestId);

    const context: { requestId: string; userId?: string } = { requestId };
    const startedAt = performance.now();
    res.on("finish", () => {
      // originalUrl: mounted routers (e.g. /graphql) rewrite req.path to their own sub-path.
      const path = req.originalUrl.split("?")[0];
      const operation = path === "/graphql" ? (req.body as { operationName?: unknown } | undefined)?.operationName : undefined;
      const entry = {
        requestId,
        ...(context.userId ? { userId: context.userId } : {}),
        method: req.method,
        path,
        ...(typeof operation === "string" ? { operation } : {}),
        status: res.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
      };
      if (res.statusCode >= 500) httpLog.error(entry, "request failed");
      else if (path.startsWith("/health")) httpLog.debug(entry, "request completed");
      else httpLog.info(entry, "request completed");
    });
    withRequestContext(context, next);
  });
  app.use((_req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Cross-Origin-Opener-Policy": "same-origin",
      ...(env.isProd
        ? {
            "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
            // The API serves JSON (attachments set their own policy): nothing should ever run
            // scripts, load resources or be framed if a response is opened directly. Not in
            // development, where the Apollo Sandbox page at /graphql needs scripts.
            "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
          }
        : {}),
    });
    next();
  });
  // Gzip JSON responses (conversation histories, the sidebar list). Chat replies stream over the
  // WebSocket, which this doesn't touch.
  app.use(compression());

  const [resolvers, graphqlUploadExpress] = await Promise.all([
    buildResolvers(),
    getGraphqlUploadExpress(),
  ]);

  const schema = makeExecutableSchema({ typeDefs, resolvers });

  const wsServer = new WebSocketServer({ server: httpServer, path: "/graphql" });
  const wsServerCleanup = useServer(
    {
      schema,
      validate: (schema, document, rules) => graphqlValidate(schema, document, [...(rules ?? specifiedRules), queryLimitsRule]),
      onConnect: (ctx) => isAllowedOrigin(ctx.extra.request.headers.origin),
      context: (ctx) => createSubscriptionContext(ctx.extra.request),
      onError: (_ctx, _id, _payload, errors) => formatGraphQLErrors(errors),
      onNext: (_ctx, _id, _payload, _args, result) =>
        result.errors ? { ...result, errors: formatGraphQLErrors(result.errors) } : undefined,
    },
    wsServer
  );

  const server = new ApolloServer<GraphQLContext>({
    schema,
    formatError: formatGraphQLError,
    validationRules: [queryLimitsRule],
    includeStacktraceInErrorResponses: false,
    plugins: [
      ApolloServerPluginDrainHttpServer({ httpServer }),
      operationLogPlugin,
      {
        async serverWillStart() {
          return {
            async drainServer() {
              await wsServerCleanup.dispose();
            },
          };
        },
      },
    ],
  });

  await server.start();
  stopServer = () => server.stop();

  app.use(
    "/graphql",
    cors<cors.CorsRequest>({
      // Reflects the request's origin only when it's allowed; requests without one (curl,
      // server-to-server) carry no browser cookies to protect, so they're let through as before.
      origin: (origin, callback) => callback(null, !origin || isAllowedOrigin(origin)),
      credentials: true,
    }),
    cookieParser(),
    graphqlUploadExpress({ maxFileSize: 25 * 1024 * 1024, maxFiles: 5 }),
    express.json({ limit: "2mb" }),
    expressMiddleware(server, {
      context: createContext,
    })
  );

  // Liveness: the process is up (cheap, for restart decisions).
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });
  // Readiness: the dependencies a request needs answer in time (for load balancers and deploys).
  app.get("/health/ready", async (_req, res) => {
    const checks = await checkDependencies();
    const ready = Object.values(checks).every((c) => c === "ok");
    res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "unavailable", checks });
  });

  app.use(attachmentRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  await new Promise<void>((resolve) => httpServer.listen({ port: env.port }, resolve));
  if (env.ingestionWorker) await startIngestionWorker(env.ingestionConcurrency);
  startKeepAwake(env.keepAwakeUrls, env.keepAwakeIntervalMs);
  log.info(
    {
      port: env.port,
      graphql: `http://localhost:${env.port}/graphql`,
      subscriptions: `ws://localhost:${env.port}/graphql`,
      langsmith: env.langsmith.enabled ? env.langsmith.project : false,
      redis: Boolean(env.redisUrl),
      ingestionWorker: env.ingestionWorker,
    },
    "server ready"
  );
}

main().catch(async (err) => {
  log.fatal({ err }, "server failed to start");
  await prisma.$disconnect();
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  log.error({ err: reason }, "unhandled promise rejection");
});

let shuttingDown = false;

/**
 * Graceful shutdown for deploys and scale-downs: let chat replies being generated finish, then
 * drain HTTP requests and close WebSockets, then disconnect. Hosts wait a limited time after
 * SIGTERM (Render: 30 s by default), so the wait for replies is bounded by env.shutdownGraceMs.
 */
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, "shutting down: finishing in-progress work");
  setTimeout(() => process.exit(1), env.shutdownGraceMs + 15_000).unref(); // last resort

  stopKeepAwake();
  await stopIngestionWorker(); // take no new jobs; the ones in progress are drained below
  const unfinished = await drainBackground(env.shutdownGraceMs);
  if (unfinished > 0) log.warn({ unfinished }, "shutting down with background work still running");
  await stopServer?.().catch((err) => log.error({ err }, "error while stopping the server"));
  log.info("shutdown complete");
  await Promise.allSettled([flushTraces(), prisma.$disconnect(), closeMongo(), closeRedis()]);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
