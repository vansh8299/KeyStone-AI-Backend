import { createHash, randomUUID, timingSafeEqual } from "crypto";
import bcrypt from "bcryptjs";
import jwt, { JwtPayload } from "jsonwebtoken";
import { Response } from "express";
import { env } from "../../config/env";

const ACCESS_TOKEN_TTL = "15m";
const REFRESH_TOKEN_TTL = "30d";
const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface AccessTokenPayload extends JwtPayload {
  userId: string;
  typ?: string;
}

const JWT_ALGORITHM = "HS256";

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export function verifyHash(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function refreshTokenMatches(token: string, storedHash: string): boolean {
  const actual = Buffer.from(hashRefreshToken(token), "hex");
  const expected = Buffer.from(storedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function signAccessToken(userId: string): string {
  return jwt.sign({ userId, typ: "access" }, env.accessTokenSecret, { expiresIn: ACCESS_TOKEN_TTL, algorithm: JWT_ALGORITHM });
}

export function signRefreshToken(userId: string): string {
  return jwt.sign({ userId, typ: "refresh" }, env.refreshTokenSecret, {
    expiresIn: REFRESH_TOKEN_TTL,
    algorithm: JWT_ALGORITHM,
    jwtid: randomUUID(),
  });
}

function verifyToken(token: string, secret: string, typ: "access" | "refresh"): AccessTokenPayload | null {
  try {
    const payload = jwt.verify(token, secret, { algorithms: [JWT_ALGORITHM] }) as AccessTokenPayload;
    return payload.typ === typ && typeof payload.userId === "string" ? payload : null;
  } catch {
    return null;
  }
}

export function verifyAccessToken(token: string): AccessTokenPayload | null {
  return verifyToken(token, env.accessTokenSecret, "access");
}

export function verifyRefreshToken(token: string): AccessTokenPayload | null {
  return verifyToken(token, env.refreshTokenSecret, "refresh");
}

const baseCookieOptions = {
  httpOnly: true,
  secure: env.isProd,
  sameSite: (env.isProd ? "none" : "lax") as "none" | "lax",
  path: "/",
};

export function setAuthCookies(res: Response, accessToken: string, refreshToken?: string): void {
  res.cookie("access_token", accessToken, { ...baseCookieOptions, maxAge: ACCESS_TOKEN_TTL_MS });
  // Omitted when the client already holds the current refresh token (see authService.refresh).
  if (refreshToken) res.cookie("refresh_token", refreshToken, { ...baseCookieOptions, maxAge: REFRESH_TOKEN_TTL_MS });
}

export function clearAuthCookies(res: Response): void {
  res.clearCookie("access_token", baseCookieOptions);
  res.clearCookie("refresh_token", baseCookieOptions);
}
