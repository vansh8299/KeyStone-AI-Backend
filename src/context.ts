import { IncomingMessage } from "http";
import { Request, Response } from "express";
import { prisma } from "./lib/prisma";
import { verifyAccessToken } from "./modules/auth/auth.utils";
import { setLogUserId } from "./lib/logger";

export interface GraphQLContext {
  prisma: typeof prisma;
  userId: string | null;
  req: Request;
  res: Response;
  /** Correlates this request's log lines (also returned as the X-Request-Id header). */
  requestId: string;
}

export interface SubscriptionContext {
  prisma: typeof prisma;
  userId: string | null;
}

function parseCookieHeader(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of header?.split(";") ?? []) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

export function createSubscriptionContext(request: IncomingMessage): SubscriptionContext {
  const token = parseCookieHeader(request.headers.cookie).access_token;
  const payload = token ? verifyAccessToken(token) : null;
  return { prisma, userId: payload?.userId ?? null };
}

export async function createContext({
  req,
  res,
}: {
  req: Request;
  res: Response;
}): Promise<GraphQLContext> {
  const token = req.cookies?.access_token as string | undefined;
  const payload = token ? verifyAccessToken(token) : null;
  setLogUserId(payload?.userId); // later log lines for this request name the user

  return {
    prisma,
    userId: payload?.userId ?? null,
    req,
    res,
    requestId: String(res.locals.requestId ?? ""),
  };
}
