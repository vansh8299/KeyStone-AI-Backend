import { randomUUID } from "crypto";
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

async function issueTokensForUser(userId: string): Promise<TokenPair> {
  const accessToken = signAccessToken(userId);
  const refreshToken = signRefreshToken(userId);
  const refreshTokenHash = hashRefreshToken(refreshToken);
  await prisma.user.update({ where: { id: userId }, data: { refreshTokenHash } });
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

  async refresh(refreshTokenCookie: string | undefined) {
    if (!refreshTokenCookie) return null;

    const payload = verifyRefreshToken(refreshTokenCookie);
    if (!payload) return null;

    const user = await prisma.user.findUnique({ where: { id: payload.userId } });
    if (!user || !user.refreshTokenHash) return null;

    if (!refreshTokenMatches(refreshTokenCookie, user.refreshTokenHash)) {
      await prisma.user.update({ where: { id: user.id }, data: { refreshTokenHash: null } });
      return null;
    }

    const tokens = await issueTokensForUser(user.id);
    return { user, ...tokens };
  },

  async logout(userId: string | null, refreshTokenCookie?: string) {
    const id = userId ?? (refreshTokenCookie ? verifyRefreshToken(refreshTokenCookie)?.userId : undefined);
    if (id) {
      await prisma.user.updateMany({ where: { id }, data: { refreshTokenHash: null } });
    }
  },
};
