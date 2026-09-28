import "dotenv/config";
import { z } from "zod";

const optionalString = z.preprocess((v) => (v === "" ? undefined : v), z.string().optional());
const withDefault = (fallback: string) =>
  z.preprocess((v) => (v === "" ? undefined : v), z.string().default(fallback));
const numberWithDefault = (fallback: number) =>
  z.preprocess((v) => (v === "" || v === undefined ? undefined : Number(v)), z.number().finite().default(fallback));

const EnvSchema = z.object({
  NODE_ENV: withDefault("development"),
  PORT: numberWithDefault(4000),
  DATABASE_URL: z.string().min(1),
  FRONTEND_ORIGIN: withDefault("http://localhost:3000"),
  TRUST_PROXY: numberWithDefault(0).pipe(z.number().int().min(0)),
  ACCESS_TOKEN_SECRET: withDefault("dev_access_secret_change_me"),
  REFRESH_TOKEN_SECRET: withDefault("dev_refresh_secret_change_me"),

  SMTP_HOST: optionalString,
  SMTP_PORT: numberWithDefault(587).pipe(z.number().int().positive()),
  SMTP_SECURE: z.preprocess((v) => (v === "" ? undefined : v), z.enum(["true", "false"]).optional()),
  SMTP_USER: optionalString,
  SMTP_PASS: optionalString,
  MAIL_FROM: withDefault("Keystone AI <no-reply@keystone.local>"),

  MONGODB_URI: z.string().min(1),
  MONGODB_DB_NAME: withDefault("rag_chat"),
  MONGODB_COLLECTION: withDefault("document_chunks"),
  MONGODB_VECTOR_INDEX: withDefault("vector_index"),

  EMBEDDING_PROVIDER: z.preprocess((v) => (v === "" ? undefined : v), z.enum(["openai", "gemini"]).default("openai")),
  OPENAI_API_KEY: optionalString,
  OPENAI_EMBEDDING_MODEL: withDefault("text-embedding-3-small"),
  GEMINI_API_KEY: optionalString,
  GEMINI_EMBEDDING_MODEL: withDefault("gemini-embedding-001"),

  LLM_PROVIDER: z.preprocess((v) => (v === "" ? undefined : v), z.enum(["openai", "gemini", "groq"]).default("groq")),
  GROQ_API_KEY: optionalString,
  GROQ_MODEL: withDefault("llama-3.3-70b-versatile"),
  GEMINI_CHAT_MODEL: withDefault("gemini-2.0-flash"),
  OPENAI_CHAT_MODEL: withDefault("gpt-4o-mini"),

  TAVILY_API_KEY: optionalString,

  KB_RELEVANCE_THRESHOLD: numberWithDefault(0.72).pipe(z.number().min(0).max(1)),

  MAX_QUESTION_CHARS: numberWithDefault(4000).pipe(z.number().int().positive()),
  LLM_MAX_OUTPUT_TOKENS: numberWithDefault(1024).pipe(z.number().int().positive()),

  REFERENCE_CHAT_HISTORY: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.enum(["true", "false"]).default("true")
  ),

  VISION_MODEL: optionalString,

  GUARDRAILS_ENABLED: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.enum(["true", "false"]).default("true")
  ),

  LANGSMITH_TRACING: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.enum(["true", "false"]).default("false")
  ),
  LANGSMITH_API_KEY: optionalString,
  LANGSMITH_PROJECT: withDefault("keystone-ai"),
  LANGSMITH_ENDPOINT: optionalString,
});

const LEGACY_LANGSMITH_NAMES = {
  LANGSMITH_TRACING: "LANGCHAIN_TRACING_V2",
  LANGSMITH_API_KEY: "LANGCHAIN_API_KEY",
  LANGSMITH_PROJECT: "LANGCHAIN_PROJECT",
  LANGSMITH_ENDPOINT: "LANGCHAIN_ENDPOINT",
} as const;
for (const [name, legacy] of Object.entries(LEGACY_LANGSMITH_NAMES)) {
  if (!process.env[name] && process.env[legacy]) process.env[name] = process.env[legacy];
}

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
  throw new Error(`Invalid environment variables:\n${issues}`);
}
const e = parsed.data;

const DEFAULT_SECRETS = new Set(["dev_access_secret_change_me", "dev_refresh_secret_change_me"]);
const weakSecret = (secret: string) => DEFAULT_SECRETS.has(secret) || secret.length < 32;
if (e.NODE_ENV === "production") {
  const problems = [
    weakSecret(e.ACCESS_TOKEN_SECRET) && "ACCESS_TOKEN_SECRET must be set to a random value of at least 32 characters",
    weakSecret(e.REFRESH_TOKEN_SECRET) && "REFRESH_TOKEN_SECRET must be set to a random value of at least 32 characters",
    e.ACCESS_TOKEN_SECRET === e.REFRESH_TOKEN_SECRET && "ACCESS_TOKEN_SECRET and REFRESH_TOKEN_SECRET must differ",
  ].filter(Boolean);
  if (problems.length > 0) throw new Error(`Invalid environment variables:\n  - ${problems.join("\n  - ")}`);
} else if (weakSecret(e.ACCESS_TOKEN_SECRET) || weakSecret(e.REFRESH_TOKEN_SECRET)) {
  console.warn("Using weak development JWT secrets — set ACCESS_TOKEN_SECRET / REFRESH_TOKEN_SECRET before deploying.");
}

if (!e.SMTP_HOST) {
  const where = e.NODE_ENV === "production" ? "sign-up and password reset will fail" : "codes are printed to the console";
  console.warn(`SMTP_HOST is not set — verification emails can't be sent; ${where}.`);
}

const langsmithEnabled = e.LANGSMITH_TRACING === "true" && Boolean(e.LANGSMITH_API_KEY);
if (e.LANGSMITH_TRACING === "true" && !e.LANGSMITH_API_KEY) {
  console.warn("LANGSMITH_TRACING=true but LANGSMITH_API_KEY is missing — LangSmith tracing is off.");
}
process.env.LANGSMITH_TRACING = String(langsmithEnabled);
process.env.LANGCHAIN_TRACING_V2 = String(langsmithEnabled);
if (langsmithEnabled) process.env.LANGSMITH_PROJECT = e.LANGSMITH_PROJECT;

const LOCAL_DEV_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/**
 * Whether a browser origin may call the API with credentials. Production allows exactly the
 * configured origins; development also allows the frontend on any local port, because `next dev`
 * silently moves to 3001, 3002… when 3000 is busy — and a mismatch there makes every request
 * fail CORS, which the app used to mistake for being logged out.
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  if (env.frontendOrigins.includes(origin)) return true;
  return !env.isProd && LOCAL_DEV_ORIGIN.test(origin);
}

export const env = {
  nodeEnv: e.NODE_ENV,
  isProd: e.NODE_ENV === "production",
  port: e.PORT,
  databaseUrl: e.DATABASE_URL,
  /** FRONTEND_ORIGIN may list several origins, comma-separated. */
  frontendOrigins: e.FRONTEND_ORIGIN.split(",").map((o) => o.trim().replace(/\/+$/, "")).filter(Boolean),
  trustProxy: e.TRUST_PROXY,
  accessTokenSecret: e.ACCESS_TOKEN_SECRET,
  refreshTokenSecret: e.REFRESH_TOKEN_SECRET,

  smtp: {
    host: e.SMTP_HOST,
    port: e.SMTP_PORT,
    /** Implicit TLS; defaults to on for port 465, otherwise STARTTLS is negotiated. */
    secure: e.SMTP_SECURE ? e.SMTP_SECURE === "true" : e.SMTP_PORT === 465,
    user: e.SMTP_USER,
    pass: e.SMTP_PASS,
  },
  mailFrom: e.MAIL_FROM,

  mongodbUri: e.MONGODB_URI,
  mongodbDbName: e.MONGODB_DB_NAME,
  mongodbCollection: e.MONGODB_COLLECTION,
  mongodbVectorIndex: e.MONGODB_VECTOR_INDEX,

  embeddingProvider: e.EMBEDDING_PROVIDER,
  openaiApiKey: e.OPENAI_API_KEY,
  openaiEmbeddingModel: e.OPENAI_EMBEDDING_MODEL,
  geminiApiKey: e.GEMINI_API_KEY,
  geminiEmbeddingModel: e.GEMINI_EMBEDDING_MODEL,

  llmProvider: e.LLM_PROVIDER,
  groqApiKey: e.GROQ_API_KEY,
  groqModel: e.GROQ_MODEL,
  geminiChatModel: e.GEMINI_CHAT_MODEL,
  openaiChatModel: e.OPENAI_CHAT_MODEL,

  tavilyApiKey: e.TAVILY_API_KEY,

  kbRelevanceThreshold: e.KB_RELEVANCE_THRESHOLD,

  maxQuestionChars: e.MAX_QUESTION_CHARS,
  llmMaxOutputTokens: e.LLM_MAX_OUTPUT_TOKENS,

  referenceChatHistory: e.REFERENCE_CHAT_HISTORY === "true",

  visionModel: e.VISION_MODEL,

  guardrailsEnabled: e.GUARDRAILS_ENABLED === "true",

  langsmith: {
    enabled: langsmithEnabled,
    project: e.LANGSMITH_PROJECT,
  },
};
