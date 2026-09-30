import { randomUUID } from "crypto";
import { GraphQLError, GraphQLFormattedError } from "graphql";
import { ErrorCode, isExposedCode } from "./errors";
import { moduleLogger } from "../lib/logger";

const log = moduleLogger("errors");

export interface ClientError {
  code: string;
  message: string;
  extensions?: Record<string, unknown>;
  expected: boolean;
}

const MESSAGES = {
  internal: "Something went wrong on our side. Please try again.",
  database: "The database is temporarily unavailable. Please try again in a moment.",
  vectorStore: "The knowledge base is temporarily unavailable. Please try again in a moment.",
  upstreamBusy: "The AI service is receiving too many requests right now. Please try again in a moment.",
  upstreamDown: "An external service we rely on is having trouble. Please try again in a moment.",
  upstreamUnreachable: "An external service we rely on can't be reached right now. Please try again in a moment.",
  misconfigured: "This feature isn't set up correctly on the server. Please contact the administrator.",
  tooLarge: "That's too large to upload. Files can be at most 25 MB.",
} as const;

const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

type ErrorLike = {
  name?: string;
  message?: string;
  code?: unknown;
  status?: unknown;
  statusCode?: unknown;
  response?: { status?: unknown };
  originalError?: unknown;
  cause?: unknown;
  extensions?: Record<string, unknown>;
};

function errorChain(error: unknown): ErrorLike[] {
  const chain: ErrorLike[] = [];
  let current: unknown = error;
  while (current && typeof current === "object" && chain.length < 10) {
    const e = current as ErrorLike;
    if (chain.includes(e)) break;
    chain.push(e);
    current = e.originalError ?? e.cause;
  }
  return chain;
}

function httpStatus(e: ErrorLike): number | null {
  const status = e.status ?? e.statusCode ?? e.response?.status;
  return typeof status === "number" ? status : null;
}

function classifyOne(e: ErrorLike): Omit<ClientError, "expected"> | null {
  const name = e.name ?? "";
  const code = typeof e.code === "string" ? e.code : "";
  const message = e.message ?? "";

  if (/^P\d{4}$/.test(code)) {
    if (code === "P2025") return { code: ErrorCode.NOT_FOUND, message: "That item no longer exists." };
    if (code === "P2002") return { code: ErrorCode.CONFLICT, message: "That already exists." };
    if (code.startsWith("P1")) return { code: ErrorCode.SERVICE_UNAVAILABLE, message: MESSAGES.database };
    return null;
  }
  if (name === "PrismaClientInitializationError" || name === "PrismaClientRustPanicError") {
    return { code: ErrorCode.SERVICE_UNAVAILABLE, message: MESSAGES.database };
  }

  if (name.startsWith("Mongo")) return { code: ErrorCode.SERVICE_UNAVAILABLE, message: MESSAGES.vectorStore };

  if (name === "PayloadTooLargeError" || httpStatus(e) === 413) {
    return { code: ErrorCode.PAYLOAD_TOO_LARGE, message: MESSAGES.tooLarge };
  }

  const status = httpStatus(e);
  if (status === 429) return { code: ErrorCode.RATE_LIMITED, message: MESSAGES.upstreamBusy };
  if (status === 401 || status === 403) {
    return { code: ErrorCode.SERVICE_UNAVAILABLE, message: MESSAGES.misconfigured };
  }
  if (status !== null && status >= 500) return { code: ErrorCode.SERVICE_UNAVAILABLE, message: MESSAGES.upstreamDown };
  if (/rate limit|too many requests|quota/i.test(message)) {
    return { code: ErrorCode.RATE_LIMITED, message: MESSAGES.upstreamBusy };
  }

  if (NETWORK_ERROR_CODES.has(code) || name === "AbortError" || name === "TimeoutError" || message === "fetch failed") {
    return { code: ErrorCode.SERVICE_UNAVAILABLE, message: MESSAGES.upstreamUnreachable };
  }

  if (/_API_KEY is required|Unsupported (LLM|EMBEDDING)_PROVIDER/.test(message)) {
    return { code: ErrorCode.SERVICE_UNAVAILABLE, message: MESSAGES.misconfigured };
  }

  return null;
}

export function toClientError(error: unknown): ClientError {
  const chain = errorChain(error);

  for (const e of [...chain].reverse()) {
    const code = e.extensions?.code;
    if (isExposedCode(code)) {
      const { code: _code, stacktrace: _stack, http: _http, ...extensions } = e.extensions ?? {};
      return { code, message: e.message ?? MESSAGES.internal, extensions, expected: true };
    }
  }

  for (const e of chain) {
    const known = classifyOne(e);
    if (known) return { ...known, expected: false };
  }
  return { code: ErrorCode.INTERNAL_SERVER_ERROR, message: MESSAGES.internal, expected: false };
}

export function logUnexpectedError(error: unknown, context: string): string {
  const errorId = randomUUID();
  log.error({ err: error, errorId, context }, "unexpected error");
  return errorId;
}

export function formatGraphQLError(formatted: GraphQLFormattedError, error: unknown): GraphQLFormattedError {
  const clientError = toClientError(error);
  const extensions: Record<string, unknown> = { ...clientError.extensions, code: clientError.code };
  if (!clientError.expected) {
    extensions.errorId = logUnexpectedError(error, `GraphQL error at ${formatted.path?.join(".") ?? "(request)"}`);
  }
  return {
    message: clientError.message,
    ...(formatted.locations ? { locations: formatted.locations } : {}),
    ...(formatted.path ? { path: formatted.path } : {}),
    extensions,
  };
}

export function formatGraphQLErrors(errors: readonly GraphQLError[]): GraphQLFormattedError[] {
  return errors.map((error) => formatGraphQLError(error.toJSON(), error));
}
