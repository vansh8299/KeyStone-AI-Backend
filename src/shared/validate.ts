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

export function boundedText(max: number) {
  return z
    .string()
    .trim()
    .min(1, "is required")
    .max(max, `must be at most ${max} characters`);
}

export const idSchema = z.string().trim().min(1, "is required").max(64, "is too long");

export const optionalUrlSchema = z.preprocess(
  (v) => (v === null || (typeof v === "string" && v.trim() === "") ? undefined : v),
  z.string().trim().max(2048, "must be at most 2048 characters").url("must be a valid URL").optional()
);
