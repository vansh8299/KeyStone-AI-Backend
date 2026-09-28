import { GraphQLContext } from "../../context";
import { unauthenticatedError } from "../../shared/errors";
import { createRateLimiter } from "../../shared/rateLimit";
import { authService } from "./auth.service";
import { setAuthCookies, clearAuthCookies } from "./auth.utils";
import { parseInput } from "../../shared/validate";
import {
  SignupArgsSchema,
  LoginArgsSchema,
  EmailArgsSchema,
  VerifyEmailArgsSchema,
  ResetPasswordArgsSchema,
} from "./auth.schemas";

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
// Sending email costs money and can be used to spam someone's inbox.
const sendCodeLimiter = createRateLimiter({
  limit: 5,
  windowMs: 60 * 60 * 1000,
  message: "Too many codes requested. Please try again later.",
});
// Per-code attempts are also capped in otpService; this stops guessing across fresh codes.
const verifyCodeLimiter = createRateLimiter({
  limit: 15,
  windowMs: 15 * 60 * 1000,
  message: "Too many attempts. Please wait a few minutes and try again.",
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
      sendCodeLimiter.consume(`email:${input.email}`);
      return authService.signup(input);
    },

    verifyEmail: async (_: unknown, args: unknown, ctx: GraphQLContext) => {
      const { input } = parseInput(VerifyEmailArgsSchema, args);
      verifyCodeLimiter.consume(`ip:${clientIp(ctx)}`, `email:${input.email}`);
      const { user, accessToken, refreshToken } = await authService.verifyEmail(input);
      setAuthCookies(ctx.res, accessToken, refreshToken);
      return { user };
    },

    resendVerificationCode: async (_: unknown, args: unknown, ctx: GraphQLContext) => {
      const { email } = parseInput(EmailArgsSchema, args);
      sendCodeLimiter.consume(`ip:${clientIp(ctx)}`, `email:${email}`);
      await authService.resendVerification(email);
      return true;
    },

    requestPasswordReset: async (_: unknown, args: unknown, ctx: GraphQLContext) => {
      const { email } = parseInput(EmailArgsSchema, args);
      sendCodeLimiter.consume(`ip:${clientIp(ctx)}`, `email:${email}`);
      await authService.requestPasswordReset(email);
      return true;
    },

    resetPassword: async (_: unknown, args: unknown, ctx: GraphQLContext) => {
      const { input } = parseInput(ResetPasswordArgsSchema, args);
      verifyCodeLimiter.consume(`ip:${clientIp(ctx)}`, `email:${input.email}`);
      await authService.resetPassword(input);
      // The reset signed out every session, including this browser's.
      clearAuthCookies(ctx.res);
      return true;
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
