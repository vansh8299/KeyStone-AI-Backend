import { z } from "zod";
import { limits } from "../../config/limits";
import { singleLineText } from "../../shared/validate";

const email = z
  .string()
  .trim()
  .min(1, "is required")
  .max(limits.emailMaxChars, `must be at most ${limits.emailMaxChars} characters`)
  .email("must be a valid email address")
  .transform((e) => e.toLowerCase());

const password = z
  .string()
  .max(1024, "is too long")
  .refine((p) => Buffer.byteLength(p, "utf8") <= limits.passwordMaxBytes, {
    message: `must be at most ${limits.passwordMaxBytes} bytes`,
  });

const newPassword = password.pipe(
  z
    .string()
    .min(limits.passwordMinChars, `must be at least ${limits.passwordMinChars} characters`)
    .refine((p) => p.trim().length > 0, { message: "can't be only spaces" })
    .refine((p) => /\p{L}/u.test(p), { message: "must include at least one letter" })
    .refine((p) => /\p{N}/u.test(p), { message: "must include at least one number" })
);

const code = z
  .string()
  .trim()
  .regex(new RegExp(`^[0-9]{${limits.otpLength}}$`), `must be the ${limits.otpLength}-digit code from the email`);

export const SignupArgsSchema = z.object({
  input: z.object({
    email,
    password: newPassword,
    name: z
      .string()
      .nullish()
      .transform((n) => n?.trim() || undefined)
      .pipe(singleLineText(limits.nameMaxChars).optional()),
  }),
});

export const LoginArgsSchema = z.object({
  input: z.object({
    email,
    password: z.string().min(1, "is required").max(1024, "is too long"),
  }),
});

export const EmailArgsSchema = z.object({ email });

export const VerifyEmailArgsSchema = z.object({
  input: z.object({ email, code }),
});

export const ResetPasswordArgsSchema = z.object({
  input: z.object({ email, code, newPassword }),
});
