import { z } from "zod";
import { limits } from "../../config/limits";

const email = z
  .string()
  .trim()
  .max(limits.emailMaxChars, `must be at most ${limits.emailMaxChars} characters`)
  .email("must be a valid email address")
  .transform((e) => e.toLowerCase());

const password = z
  .string()
  .max(1024, "is too long")
  .refine((p) => Buffer.byteLength(p, "utf8") <= limits.passwordMaxBytes, {
    message: `must be at most ${limits.passwordMaxBytes} bytes`,
  });

export const SignupArgsSchema = z.object({
  input: z.object({
    email,
    password: password.pipe(
      z.string().min(limits.passwordMinChars, `must be at least ${limits.passwordMinChars} characters`)
    ),
    name: z
      .string()
      .trim()
      .max(limits.nameMaxChars, `must be at most ${limits.nameMaxChars} characters`)
      .nullish()
      .transform((n) => n || undefined),
  }),
});

export const LoginArgsSchema = z.object({
  input: z.object({
    email,
    password: z.string().min(1, "is required").max(1024, "is too long"),
  }),
});
