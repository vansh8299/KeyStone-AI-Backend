import type { ApolloServerPlugin } from "@apollo/server";
import type { GraphQLContext } from "../context";
import { moduleLogger } from "../lib/logger";

const log = moduleLogger("graphql");

/** Operations slower than this are logged, to spot regressions and slow dependencies. */
const SLOW_OPERATION_MS = 1_500;

/**
 * Logs GraphQL operations that were slow or failed, one JSON line each, so they can be searched
 * and aggregated in the host's logs: operation name, duration, request ID and error codes.
 * Variables are never logged (they can hold passwords, codes and chat messages).
 */
export const operationLogPlugin: ApolloServerPlugin<GraphQLContext> = {
  async requestDidStart({ contextValue }) {
    const startedAt = performance.now();
    return {
      async willSendResponse({ operationName, response, errors }) {
        const durationMs = Math.round(performance.now() - startedAt);
        // Errors are seen before formatting: an unexpected one may not have a code yet.
        const errorCodes = (errors ?? []).map((e) =>
          typeof e.extensions?.code === "string" ? e.extensions.code : "INTERNAL_SERVER_ERROR"
        );
        // Expected, user-caused errors (bad input, not signed in, rate limited) aren't worth a log line.
        const unexpected = errorCodes.some((code) => code === "INTERNAL_SERVER_ERROR" || code === "SERVICE_UNAVAILABLE");
        if (durationMs < SLOW_OPERATION_MS && !unexpected) return;
        const entry = {
          operation: operationName ?? "(anonymous)",
          durationMs,
          requestId: contextValue.requestId,
          ...(errorCodes.length > 0 ? { errorCodes } : {}),
          ...(response.http.status ? { status: response.http.status } : {}),
        };
        if (unexpected) log.error(entry, "graphql operation failed");
        else log.warn(entry, "slow graphql operation");
      },
    };
  },
};
