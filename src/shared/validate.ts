import { z } from "zod";
import { badUserInputError } from "./errors";

function fieldLabel(path: (string | number)[]): string {
  const name = [...path].reverse().find((p): p is string => typeof p === "string" && p !== "input");
  if (!name) return "";
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/\b(url|id)\b/g, (w) => w.toUpperCase());
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function parseInput<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    const label = fieldLabel(issue.path);
    const message = !label
      ? issue.message
      : /^[a-z]/.test(issue.message)
        ? `${label} ${issue.message}`
        : `${label}: ${issue.message}`;
    throw badUserInputError(message, { field: issue.path.join(".") });
  }
  return result.data;
}

// Control characters other than tab / newline / carriage return never belong in user text.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
// Single-line fields (names, titles) additionally reject line breaks and tabs.
const LINE_BREAKS = /[\t\n\r\u2028\u2029]/;

export function boundedText(max: number) {
  return z
    .string()
    .trim()
    .min(1, "is required")
    .max(max, `must be at most ${max} characters`)
    .refine((s) => !CONTROL_CHARS.test(s), { message: "contains invalid characters" });
}

/** A required single-line string: trimmed, length-bounded, no control characters or line breaks. */
export function singleLineText(max: number) {
  return boundedText(max).refine((s) => !LINE_BREAKS.test(s), { message: "must be a single line" });
}

// IDs are Prisma cuids; accept any short URL-safe token so malformed IDs are rejected
// before they reach the database.
export const idSchema = z
  .string()
  .trim()
  .min(1, "is required")
  .max(64, "is too long")
  .regex(/^[A-Za-z0-9_-]+$/, "is invalid");

export const IdArgsSchema = z.object({ id: idSchema });

export const urlSchema = z
  .string()
  .trim()
  .max(2048, "must be at most 2048 characters")
  .url("must be a valid URL")
  .refine((v) => /^https?:\/\//i.test(v), "must be an http or https link");

export const optionalUrlSchema = z.preprocess(
  (v) => (v === null || (typeof v === "string" && v.trim() === "") ? undefined : v),
  z.string().trim().max(2048, "must be at most 2048 characters").url("must be a valid URL").optional()
);
