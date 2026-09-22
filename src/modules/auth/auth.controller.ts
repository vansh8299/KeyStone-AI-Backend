import { GraphQLContext } from "../../context";
import { unauthenticatedError } from "../../shared/errors";
import { createRateLimiter } from "../../shared/rateLimit";
import { authService } from "./auth.service";
import { setAuthCookies, clearAuthCookies } from "./auth.utils";
import { parseInput } from "../../shared/validate";
import { SignupArgsSchema, LoginArgsSchema } from "./auth.schemas";

const loginLimiter = createRateLimiter({
  limit: 10,
  windowMs: 15 * 60 * 1000,
  message: "Too many login attempts. Please wait a few minutes and try again.",
});
const signupLimiter = createRateLimiter({
  limit: 5,
  windowMs: 60 * 60 * 1000,
  message: "Too many sign-up attempts. Please try again later.",
});
const refreshLimiter = createRateLimiter({
  limit: 60,
  windowMs: 15 * 60 * 1000,
  message: "Too many requests. Please try again in a few minutes.",
});

function clientIp(ctx: GraphQLContext): string {
  return ctx.req.ip ?? ctx.req.socket.remoteAddress ?? "unknown";
}

export const authController = {
  Mutation: {
    signup: async (_: unknown, args: unknown, ctx: GraphQLContext) => {
      signupLimiter.consume(`ip:${clientIp(ctx)}`);
      const { input } = parseInput(SignupArgsSchema, args);
      const { user, accessToken, refreshToken } = await authService.signup(input);
      setAuthCookies(ctx.res, accessToken, refreshToken);
      return { user };
    },

    login: async (_: unknown, args: unknown, ctx: GraphQLContext) => {
      const { input } = parseInput(LoginArgsSchema, args);
      const accountKey = `email:${input.email.toLowerCase()}`;
      loginLimiter.consume(`ip:${clientIp(ctx)}`, accountKey);
      const { user, accessToken, refreshToken } = await authService.login(input);
      loginLimiter.reset(accountKey);
      setAuthCookies(ctx.res, accessToken, refreshToken);
      return { user };
    },

    refreshToken: async (_: unknown, __: unknown, ctx: GraphQLContext) => {
      refreshLimiter.consume(`ip:${clientIp(ctx)}`);
      const result = await authService.refresh(ctx.req.cookies?.refresh_token);
      if (!result) {
        clearAuthCookies(ctx.res);
        throw unauthenticatedError("Your session has expired. Please log in again.");
      }
      setAuthCookies(ctx.res, result.accessToken, result.refreshToken);
      return { user: result.user };
    },

    logout: async (_: unknown, __: unknown, ctx: GraphQLContext) => {
      await authService.logout(ctx.userId, ctx.req.cookies?.refresh_token);
      clearAuthCookies(ctx.res);
      return true;
    },
  },
};
