import { AsyncLocalStorage } from "async_hooks";
import pino, { type Logger } from "pino";
import { env } from "../config/env";

/**
 * Structured logging for the whole backend.
 *
 * - One JSON object per line in production (searchable and filterable in the host's log viewer);
 *   readable, coloured lines in development.
 * - Level from LOG_LEVEL: debug in development, info in production by default.
 * - Every line written while handling a request carries its requestId (and userId once known),
 *   via AsyncLocalStorage — no need to pass them around.
 * - Secrets are redacted wherever they appear: passwords, tokens, cookies, API keys, codes.
 *
 * Modules log through a child logger: `const log = logger.child({ module: "ingestion" })`, and pass
 * data as the first argument: `log.info({ documentId, durationMs }, "document ready")`.
 */

interface RequestContext {
  requestId: string;
  userId?: string;
}

const requestContext = new AsyncLocalStorage<RequestContext>();

/** Runs `fn` with a request context that every log line inside it (and its async work) picks up. */
export function withRequestContext<T>(context: RequestContext, fn: () => T): T {
  return requestContext.run(context, fn);
}

/** Adds the signed-in user to the current request's log context. */
export function setLogUserId(userId: string | null | undefined): void {
  const store = requestContext.getStore();
  if (store && userId) store.userId = userId;
}

const REDACTED_KEYS = [
  "password",
  "newPassword",
  "passwordHash",
  "token",
  "accessToken",
  "refreshToken",
  "access_token",
  "refresh_token",
  "refreshTokenHash",
  "codeHash",
  "secret",
  "apiKey",
  "authorization",
  "cookie",
];

/** Pretty output needs the dev-only pino-pretty package; fall back to JSON if it isn't installed. */
function prettyAvailable(): boolean {
  if (env.isProd) return false;
  try {
    require.resolve("pino-pretty");
    return true;
  } catch {
    return false;
  }
}

export const logger: Logger = pino({
  level: env.logLevel,
  base: { service: process.env.LOG_SERVICE ?? "api", env: env.nodeEnv },
  timestamp: pino.stdTimeFunctions.isoTime,
  // Request context on every line logged during a request.
  mixin: () => {
    const store = requestContext.getStore();
    return store ? { requestId: store.requestId, ...(store.userId ? { userId: store.userId } : {}) } : {};
  },
  redact: {
    paths: [
      ...REDACTED_KEYS,
      ...REDACTED_KEYS.map((k) => `*.${k}`),
      ...REDACTED_KEYS.map((k) => `*.*.${k}`),
      'req.headers["x-mail-trigger-secret"]',
    ],
    censor: "[redacted]",
  },
  serializers: { err: pino.stdSerializers.err, error: pino.stdSerializers.err },
  formatters: { level: (label) => ({ level: label }) },
  ...(prettyAvailable()
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname,service,env" },
        },
      }
    : {}),
});

/** Shorthand for a module's logger. */
export function moduleLogger(module: string): Logger {
  return logger.child({ module });
}
