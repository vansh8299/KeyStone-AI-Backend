import { createHmac, randomInt, timingSafeEqual } from "crypto";
import type { OtpPurpose } from "@prisma/client";
import { env } from "../../config/env";
import { limits } from "../../config/limits";
import { prisma } from "../../lib/prisma";
import { sendMail } from "../../lib/mailer";
import { badUserInputError, rateLimitedError } from "../../shared/errors";

export const INVALID_CODE = "That code is incorrect or has expired. Check the email or request a new code.";

function hashCode(userId: string, purpose: OtpPurpose, code: string): string {
  return createHmac("sha256", env.refreshTokenSecret).update(`${userId}:${purpose}:${code}`).digest("hex");
}

function codesMatch(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}

const EMAILS: Record<OtpPurpose, { subject: string; intro: string }> = {
  VERIFY_EMAIL: {
    subject: "Verify your email for Keystone AI",
    intro: "Use this code to verify your email address and finish creating your Keystone AI account.",
  },
  RESET_PASSWORD: {
    subject: "Reset your Keystone AI password",
    intro: "Use this code to reset your Keystone AI password.",
  },
};

function buildEmail(purpose: OtpPurpose, code: string) {
  const { subject, intro } = EMAILS[purpose];
  const minutes = Math.round(limits.otpTtlMs / 60_000);
  const outro = `The code expires in ${minutes} minutes. If you didn't request it, you can ignore this email.`;
  const text = `${intro}\n\n${code}\n\n${outro}`;
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1a1a1a">
  <h2 style="margin:0 0 12px;font-size:20px">${subject}</h2>
  <p style="margin:0 0 20px;font-size:14px;line-height:1.5">${intro}</p>
  <p style="margin:0 0 20px;font-size:32px;font-weight:700;letter-spacing:8px;font-family:ui-monospace,Menlo,monospace">${code}</p>
  <p style="margin:0;font-size:13px;line-height:1.5;color:#666">${outro}</p>
</div>`;
  return { subject, text, html };
}

export const otpService = {
  /**
   * Emails a fresh code, replacing any earlier one for the same purpose. Throws RATE_LIMITED if
   * a code was sent less than `otpResendCooldownMs` ago.
   */
  async issue(user: { id: string; email: string }, purpose: OtpPurpose): Promise<void> {
    const existing = await prisma.emailOtp.findUnique({ where: { userId_purpose: { userId: user.id, purpose } } });
    const waitMs = existing ? existing.createdAt.getTime() + limits.otpResendCooldownMs - Date.now() : 0;
    if (waitMs > 0) {
      const seconds = Math.ceil(waitMs / 1000);
      throw rateLimitedError(`Please wait ${seconds}s before requesting another code.`, seconds);
    }

    const code = randomInt(0, 10 ** limits.otpLength).toString().padStart(limits.otpLength, "0");
    const data = {
      codeHash: hashCode(user.id, purpose, code),
      attempts: 0,
      expiresAt: new Date(Date.now() + limits.otpTtlMs),
      createdAt: new Date(),
    };
    const otp = await prisma.emailOtp.upsert({
      where: { userId_purpose: { userId: user.id, purpose } },
      create: { userId: user.id, purpose, ...data },
      update: data,
    });

    try {
      await sendMail({ to: user.email, ...buildEmail(purpose, code) });
    } catch (err) {
      // Don't leave an undeliverable code behind: it would block a retry until the cooldown ends.
      await prisma.emailOtp.deleteMany({ where: { id: otp.id } });
      throw err;
    }
  },

  /** Checks and consumes a code. Every failure throws the same BAD_USER_INPUT on the `code` field. */
  async consume(userId: string | undefined, purpose: OtpPurpose, code: string): Promise<void> {
    const invalid = () => badUserInputError(INVALID_CODE, { field: "input.code" });
    if (!userId) throw invalid();

    const otp = await prisma.emailOtp.findUnique({ where: { userId_purpose: { userId, purpose } } });
    if (!otp || otp.expiresAt.getTime() <= Date.now() || otp.attempts >= limits.otpMaxAttempts) throw invalid();

    if (!codesMatch(hashCode(userId, purpose, code), otp.codeHash)) {
      const attempts = otp.attempts + 1;
      if (attempts >= limits.otpMaxAttempts) {
        await prisma.emailOtp.deleteMany({ where: { id: otp.id } });
      } else {
        await prisma.emailOtp.updateMany({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
      }
      throw invalid();
    }

    // Deleting by id + hash makes the code single-use even if two requests race.
    const { count } = await prisma.emailOtp.deleteMany({ where: { id: otp.id, codeHash: otp.codeHash } });
    if (count === 0) throw invalid();
  },
};
