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
import { closeMongo } from "./lib/mongo";
import { closeRedis } from "./lib/redis";
import { activeTurns } from "./modules/rag/activeTurns";
import { validate as graphqlValidate, specifiedRules } from "graphql";
import { queryLimitsRule } from "./graphql/queryLimits";

/** Set once the server is running; stops it (draining HTTP requests and closing WebSockets). */
let stopServer: (() => Promise<void>) | null = null;

async function main() {
  const app = express();
  const httpServer = http.createServer(app);

  if (env.trustProxy > 0) app.set("trust proxy", env.trustProxy);
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      ...(env.isProd ? { "Strict-Transport-Security": "max-age=31536000; includeSubDomains" } : {}),
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

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use(attachmentRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  await new Promise<void>((resolve) => httpServer.listen({ port: env.port }, resolve));
  console.log(`🚀 Server ready at http://localhost:${env.port}/graphql`);
  console.log(`🔌 Subscriptions ready at ws://localhost:${env.port}/graphql`);
  if (env.langsmith.enabled) console.log(`🔎 LangSmith tracing on (project "${env.langsmith.project}")`);
}

main().catch(async (err) => {
  console.error("Fatal error starting server:", err);
  await prisma.$disconnect();
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
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
  console.log(`${signal} received — finishing in-progress work before exiting…`);
  setTimeout(() => process.exit(1), env.shutdownGraceMs + 15_000).unref(); // last resort

  const unfinished = await activeTurns.drain(env.shutdownGraceMs);
  if (unfinished > 0) console.warn(`Shutting down with ${unfinished} chat repl${unfinished === 1 ? "y" : "ies"} still running.`);
  await stopServer?.().catch((err) => console.error("Error while stopping the server:", err));
  await Promise.allSettled([flushTraces(), prisma.$disconnect(), closeMongo(), closeRedis()]);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
