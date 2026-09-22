import { z } from "zod";

export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : (part as { text?: string })?.text ?? ""))
      .join("");
  }
  return "";
}

export function parseJsonFromLlm<T extends z.ZodTypeAny>(text: string, schema: T): z.infer<T> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    console.warn("LLM output failed schema validation:", result.error.flatten());
    return null;
  }
  return result.data;
}

const trimmedString = z.string().trim();

export const AmbiguityVerdictSchema = z.object({
  standaloneQuestion: trimmedString.optional(),
  ambiguous: z
    .union([z.boolean(), z.enum(["true", "false"]).transform((v) => v === "true")])
    .optional()
    .default(false),
  clarifyingQuestion: trimmedString.optional(),
});
export type AmbiguityVerdict = z.infer<typeof AmbiguityVerdictSchema>;

export const EntryLabelSchema = z
  .string()
  .transform((s) => {
    const word = s.toUpperCase().replace(/[^A-Z]/g, "");
    if (word.startsWith("GREET")) return "GREETING";
    if (word.startsWith("QUEST")) return "QUESTION";
    return word;
  })
  .pipe(z.enum(["GREETING", "QUESTION"]));

export const NonEmptyTextSchema = trimmedString.min(1);

export const GuardrailVerdictSchema = z.object({
  approved: z.union([z.boolean(), z.enum(["true", "false"]).transform((v) => v === "true")]),
  category: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.enum(["safety", "grounding", "relevance", "quality"]))
    .catch("quality"),
  feedback: trimmedString.optional().default(""),
});
export type GuardrailVerdict = z.infer<typeof GuardrailVerdictSchema>;
