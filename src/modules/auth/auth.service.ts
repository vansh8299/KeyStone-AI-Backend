import { randomUUID } from "crypto";
import type { User } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { conflictError, unauthenticatedError } from "../../shared/errors";
import {
  hashPassword,
  verifyHash,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  hashRefreshToken,
  refreshTokenMatches,
} from "./auth.utils";

/**
 * How long a just-replaced refresh token is still accepted. Two tabs refreshing at once, or a
 * refresh that was already in flight when the user logged in, present the previous token a moment
 * after it was replaced. Treating that as theft would revoke the session the user just created.
 */
const REFRESH_REUSE_GRACE_MS = 60_000;

const EMAIL_TAKEN = "An account with this email already exists. Try logging in instead.";

const dummyPasswordHash = hashPassword(randomUUID());

function findUserByEmail(email: string) {
  return prisma.user.findFirst({ where: { email: { equals: email, mode: "insensitive" } } });
}

export interface SignupInput {
  email: string;
  password: string;
  name?: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface RefreshResult {
  user: User;
  accessToken: string;
  /** Absent when a just-replaced token was presented: the browser already holds the newer one. */
  refreshToken?: string;
}

async function issueTokensForUser(userId: string): Promise<TokenPair> {
  const accessToken = signAccessToken(userId);
  const refreshToken = signRefreshToken(userId);
  const refreshTokenHash = hashRefreshToken(refreshToken);
  await prisma.user.update({ where: { id: userId }, data: { refreshTokenHash, refreshTokenIssuedAt: new Date() } });
  return { accessToken, refreshToken };
}

export const authService = {
  async signup(input: SignupInput) {
    const existing = await findUserByEmail(input.email);
    if (existing) throw conflictError(EMAIL_TAKEN);
    const passwordHash = await hashPassword(input.password);
    const user = await prisma.user
      .create({ data: { email: input.email, name: input.name, password: passwordHash } })
      .catch((err: { code?: string }) => {
        throw err?.code === "P2002" ? conflictError(EMAIL_TAKEN) : err;
      });

    const tokens = await issueTokensForUser(user.id);
    return { user, ...tokens };
  },

  async login(input: LoginInput) {
    const user = await findUserByEmail(input.email);
    const passwordOk = await verifyHash(input.password, user?.password ?? (await dummyPasswordHash));
    if (!user || !passwordOk) {
      throw unauthenticatedError("Incorrect email or password.");
    }

    const tokens = await issueTokensForUser(user.id);
    return { user, ...tokens };
  },

  async refresh(refreshTokenCookie: string | undefined): Promise<RefreshResult | null> {
    if (!refreshTokenCookie) return null;

    const payload = verifyRefreshToken(refreshTokenCookie);
    if (!payload) return null;

    const user = await prisma.user.findUnique({ where: { id: payload.userId } });
    if (!user || !user.refreshTokenHash) return null;

    if (!refreshTokenMatches(refreshTokenCookie, user.refreshTokenHash)) {
      const issuedAt = user.refreshTokenIssuedAt?.getTime();
      const tokenIssuedAt = (payload.iat ?? 0) * 1000;
      const justReplaced =
        issuedAt !== undefined && tokenIssuedAt <= issuedAt && Date.now() - issuedAt < REFRESH_REUSE_GRACE_MS;
      if (justReplaced) {
        // Benign race: hand out a fresh access token but leave the current session untouched.
        return { user, accessToken: signAccessToken(user.id) };
      }
      // An old token replayed long after it was replaced: assume theft and end the session.
      await prisma.user.update({ where: { id: user.id }, data: { refreshTokenHash: null, refreshTokenIssuedAt: null } });
      return null;
    }

    const tokens = await issueTokensForUser(user.id);
    return { user, ...tokens };
  },

  async logout(userId: string | null, refreshTokenCookie?: string) {
    const id = userId ?? (refreshTokenCookie ? verifyRefreshToken(refreshTokenCookie)?.userId : undefined);
    if (id) {
      await prisma.user.updateMany({ where: { id }, data: { refreshTokenHash: null, refreshTokenIssuedAt: null } });
    }
  },
};
