import { getChatModel } from "../rag/langchain/chatModel";
import { traceConfig, type TraceContext } from "../../lib/langsmith";
import { extractText, NonEmptyTextSchema } from "../rag/langchain/llmOutput";
import { limits } from "../../config/limits";

const TITLE_MAX_LENGTH = 60;

const TITLE_PROMPT = `You write short titles for chat conversations.
Given the user's first message, reply with a concise title of 3 to 6 words that captures the topic.
Rules: no quotes, no trailing punctuation, no emojis, no prefixes like "Title:". Reply with the title only.`;

function clamp(text: string): string {
  return text.length > TITLE_MAX_LENGTH ? `${text.slice(0, TITLE_MAX_LENGTH - 1)}…` : text;
}

export function fallbackTitle(firstMessage: string): string {
  return clamp(firstMessage.trim().replace(/\s+/g, " ")) || "New conversation";
}

export async function generateTitle(firstMessage: string, trace?: TraceContext): Promise<string> {
  try {
    const response = await getChatModel(limits.titleMaxTokens).invoke(
      [
        ["system", TITLE_PROMPT],
        ["human", firstMessage.slice(0, 2000)],
      ],
      traceConfig("conversation_title", trace, ["background"])
    );
    const title = NonEmptyTextSchema.safeParse(
      extractText(response.content)
        .split("\n")[0]
        .replace(/^title:\s*/i, "")
        .replace(/^["'`*]+|["'`*.!?:;]+$/g, "")
    );
    return title.success ? clamp(title.data) : fallbackTitle(firstMessage);
  } catch (err) {
    console.error("Conversation title generation failed:", err);
    return fallbackTitle(firstMessage);
  }
}
