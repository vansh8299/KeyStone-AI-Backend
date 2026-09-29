import { GraphQLError } from "graphql";

export const ErrorCode = {
  UNAUTHENTICATED: "UNAUTHENTICATED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  BAD_USER_INPUT: "BAD_USER_INPUT",
  CONFLICT: "CONFLICT",
  EMAIL_NOT_VERIFIED: "EMAIL_NOT_VERIFIED",
  RATE_LIMITED: "RATE_LIMITED",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  INTERNAL_SERVER_ERROR: "INTERNAL_SERVER_ERROR",
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

function appError(code: ErrorCode, message: string, extensions: Record<string, unknown> = {}) {
  return new GraphQLError(message, { extensions: { ...extensions, code } });
}

export function unauthenticatedError(message = "Please log in to continue."): GraphQLError {
  return appError(ErrorCode.UNAUTHENTICATED, message);
}

export function forbiddenError(message = "You don't have access to this."): GraphQLError {
  return appError(ErrorCode.FORBIDDEN, message);
}

export function notFoundError(message = "Not found"): GraphQLError {
  return appError(ErrorCode.NOT_FOUND, message);
}

export function badUserInputError(message: string, extensions: { field?: string } = {}): GraphQLError {
  return appError(ErrorCode.BAD_USER_INPUT, message, extensions);
}

export function conflictError(message: string): GraphQLError {
  return appError(ErrorCode.CONFLICT, message);
}

export function emailNotVerifiedError(email: string): GraphQLError {
  return appError(
    ErrorCode.EMAIL_NOT_VERIFIED,
    "Please verify your email address. We've sent a code to your inbox.",
    { email }
  );
}

export function rateLimitedError(message: string, retryAfterSeconds?: number): GraphQLError {
  return appError(ErrorCode.RATE_LIMITED, message, retryAfterSeconds ? { retryAfterSeconds } : {});
}

export function payloadTooLargeError(message: string): GraphQLError {
  return appError(ErrorCode.PAYLOAD_TOO_LARGE, message);
}

export function serviceUnavailableError(message: string): GraphQLError {
  return appError(ErrorCode.SERVICE_UNAVAILABLE, message);
}

const EXPOSED_CODES = new Set<string>(Object.values(ErrorCode).filter((c) => c !== ErrorCode.INTERNAL_SERVER_ERROR));

const REQUEST_CODES = new Set([
  "GRAPHQL_PARSE_FAILED",
  "GRAPHQL_VALIDATION_FAILED",
  "BAD_REQUEST",
  "PERSISTED_QUERY_NOT_FOUND",
  "PERSISTED_QUERY_NOT_SUPPORTED",
  "OPERATION_RESOLUTION_FAILURE",
]);

export function isExposedCode(code: unknown): code is string {
  return typeof code === "string" && (EXPOSED_CODES.has(code) || REQUEST_CODES.has(code));
}
