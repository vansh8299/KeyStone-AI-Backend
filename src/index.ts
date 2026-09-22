import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import http from "http";
import { ApolloServer } from "@apollo/server";
import { expressMiddleware } from "@as-integrations/express5";
import { ApolloServerPluginDrainHttpServer } from "@apollo/server/plugin/drainHttpServer";

import { env } from "./config/env";
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
import { validate as graphqlValidate, specifiedRules } from "graphql";
import { queryLimitsRule } from "./graphql/queryLimits";

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
      onConnect: (ctx) => ctx.extra.request.headers.origin === env.frontendOrigin,
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

  app.use(
    "/graphql",
    cors<cors.CorsRequest>({
      origin: env.frontendOrigin,
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

async function shutdown() {
  await Promise.all([flushTraces(), prisma.$disconnect()]);
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
