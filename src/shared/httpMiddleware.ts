import { NextFunction, Request, Response } from "express";
import { ErrorCode } from "./errors";
import { logUnexpectedError, toClientError } from "./errorHandling";

function sendError(res: Response, status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
  res.status(status).json({ errors: [{ message, extensions: { code, ...extra } }] });
}

export function notFoundHandler(req: Request, res: Response) {
  sendError(res, 404, ErrorCode.NOT_FOUND, `No route for ${req.method} ${req.path}`);
}

type HttpError = Error & { status?: number; statusCode?: number; type?: string; expose?: boolean };

export function errorHandler(err: HttpError, req: Request, res: Response, next: NextFunction) {
  if (res.headersSent) return next(err);

  const status = err.status ?? err.statusCode ?? 500;

  if (err.type === "entity.parse.failed") {
    return sendError(res, 400, "BAD_REQUEST", "The request body isn't valid JSON.");
  }
  if (status === 413 || err.type === "entity.too.large") {
    return sendError(res, 413, ErrorCode.PAYLOAD_TOO_LARGE, "That's too large to upload. Files can be at most 25 MB, and up to 5 at a time.");
  }
  if (status >= 400 && status < 500 && err.expose !== false) {
    return sendError(res, status, "BAD_REQUEST", err.message || "The request couldn't be processed.");
  }

  const clientError = toClientError(err);
  const errorId = logUnexpectedError(err, `HTTP ${req.method} ${req.path}`);
  sendError(res, clientError.code === ErrorCode.INTERNAL_SERVER_ERROR ? 500 : 503, clientError.code, clientError.message, { errorId });
}
