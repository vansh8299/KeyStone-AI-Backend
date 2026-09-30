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
import { moduleLogger } from "../../lib/logger";

const log = moduleLogger("auth");

const loginLimiter = createRateLimiter({
  name: "login",
  limit: 10,
  windowMs: 15 * 60 * 1000,
  message: "Too many login attempts. Please wait a few minutes and try again.",
});
const signupLimiter = createRateLimiter({
  name: "signup",
  limit: 5,
  windowMs: 60 * 60 * 1000,
  message: "Too many sign-up attempts. Please try again later.",
});
// Sending email costs money and can be used to spam someone's inbox.
const sendCodeLimiter = createRateLimiter({
  name: "send-code",
  limit: 5,
  windowMs: 60 * 60 * 1000,
  message: "Too many codes requested. Please try again later.",
});
// Per-code attempts are also capped in otpService; this stops guessing across fresh codes.
const verifyCodeLimiter = createRateLimiter({
  name: "verify-code",
  limit: 15,
  windowMs: 15 * 60 * 1000,
  message: "Too many attempts. Please wait a few minutes and try again.",
});
const refreshLimiter = createRateLimiter({
  name: "refresh",
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
      await signupLimiter.consume(`ip:${clientIp(ctx)}`);
      const { input } = parseInput(SignupArgsSchema, args);
      await sendCodeLimiter.consume(`email:${input.email}`);
      const result = await authService.signup(input);
      log.info({ ip: clientIp(ctx) }, "account created; verification code sent");
      return result;
    },

    verifyEmail: async (_: unknown, args: unknown, ctx: GraphQLContext) => {
      const { input } = parseInput(VerifyEmailArgsSchema, args);
      await verifyCodeLimiter.consume(`ip:${clientIp(ctx)}`, `email:${input.email}`);
      const { user, accessToken, refreshToken } = await authService.verifyEmail(input);
      setAuthCookies(ctx.res, accessToken, refreshToken);
      log.info({ userId: user.id }, "email verified; signed in");
      return { user };
    },

    resendVerificationCode: async (_: unknown, args: unknown, ctx: GraphQLContext) => {
      const { email } = parseInput(EmailArgsSchema, args);
      await sendCodeLimiter.consume(`ip:${clientIp(ctx)}`, `email:${email}`);
      await authService.resendVerification(email);
      return true;
    },

    requestPasswordReset: async (_: unknown, args: unknown, ctx: GraphQLContext) => {
      const { email } = parseInput(EmailArgsSchema, args);
      await sendCodeLimiter.consume(`ip:${clientIp(ctx)}`, `email:${email}`);
      await authService.requestPasswordReset(email);
      log.info({ ip: clientIp(ctx) }, "password reset requested");
      return true;
    },

    resetPassword: async (_: unknown, args: unknown, ctx: GraphQLContext) => {
      const { input } = parseInput(ResetPasswordArgsSchema, args);
      await verifyCodeLimiter.consume(`ip:${clientIp(ctx)}`, `email:${input.email}`);
      await authService.resetPassword(input);
      // The reset signed out every session, including this browser's.
      clearAuthCookies(ctx.res);
      log.info({ ip: clientIp(ctx) }, "password reset completed; all sessions signed out");
      return true;
    },

    login: async (_: unknown, args: unknown, ctx: GraphQLContext) => {
      const { input } = parseInput(LoginArgsSchema, args);
      const accountKey = `email:${input.email.toLowerCase()}`;
      await loginLimiter.consume(`ip:${clientIp(ctx)}`, accountKey);
      let result;
      try {
        result = await authService.login(input);
      } catch (err) {
        const code = (err as { extensions?: { code?: unknown } }).extensions?.code;
        if (code === "UNAUTHENTICATED") log.warn({ ip: clientIp(ctx) }, "login failed: wrong email or password");
        else if (code === "EMAIL_NOT_VERIFIED") log.info({ ip: clientIp(ctx) }, "login blocked: email not verified");
        throw err;
      }
      const { user, accessToken, refreshToken } = result;
      await loginLimiter.reset(accountKey);
      setAuthCookies(ctx.res, accessToken, refreshToken);
      log.info({ userId: user.id, ip: clientIp(ctx) }, "signed in");
      return { user };
    },

    refreshToken: async (_: unknown, __: unknown, ctx: GraphQLContext) => {
      await refreshLimiter.consume(`ip:${clientIp(ctx)}`);
      const result = await authService.refresh(ctx.req.cookies?.refresh_token);
      if (!result) {
        clearAuthCookies(ctx.res);
        log.debug("session refresh rejected");
        throw unauthenticatedError("Your session has expired. Please log in again.");
      }
      setAuthCookies(ctx.res, result.accessToken, result.refreshToken);
      return { user: result.user };
    },

    logout: async (_: unknown, __: unknown, ctx: GraphQLContext) => {
      await authService.logout(ctx.userId, ctx.req.cookies?.refresh_token);
      clearAuthCookies(ctx.res);
      log.info({ userId: ctx.userId }, "signed out");
      return true;
    },
  },
};
