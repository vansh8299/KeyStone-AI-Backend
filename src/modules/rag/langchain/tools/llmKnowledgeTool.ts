import { tool } from "@langchain/core/tools";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import { getAnswerModel } from "../chatModel";
import { toLangChainMessages, withMemoryContext } from "../history";
import { extractText } from "../llmOutput";
import { FILE_FORMATS } from "../../responseFiles/formats";

export const LLM_KNOWLEDGE_TOOL_NAME = "llm_knowledge";

export const CANNOT_ANSWER_MARKER = "NEEDS_WEB_SEARCH";

export function createLlmKnowledgeTool() {
  return tool(
    async ({ question, history, userName, outputFile, conversationSummary, pastConversations, attachedImages, attachedDocuments }): Promise<string> => {
      const response = await getAnswerModel(outputFile).invoke([
        new SystemMessage(
          withMemoryContext(
            `Answer the question from your own general knowledge if you can do so confidently and ` +
              `accurately — most general-knowledge questions (concepts, definitions, how things work, ` +
              `historical facts) should be answered this way. ` +
              (attachedImages
                ? `Questions about the attached images (what they show, the text in them, explaining ` +
                  `or fixing what's in them) are answerable: use their content below. `
                : "") +
              (attachedDocuments
                ? `Questions about the attached documents (summaries, facts, figures, comparisons, ` +
                  `analysis) are answerable: use their content below. `
                : "") +
              (pastConversations
                ? `Questions about people, projects, files or anything else from your past ` +
                  `conversations with this user are answerable: use that memory below, and say it's ` +
                  `from an earlier chat. If the question could mean someone or something from that ` +
                  `memory, answer about that first. `
                : "") +
              `Only if the question needs current/live ` +
              `information you can't know (news, prices, today's date, recent releases, anything ` +
              `time-sensitive), or you're genuinely not confident in the answer, respond with EXACTLY ` +
              `the single word "${CANNOT_ANSWER_MARKER}" and nothing else — do not guess and do not ` +
              `add any other text alongside that word.`,
            { userName, outputFile, conversationSummary, pastConversations, attachedImages, attachedDocuments }
          )
        ),
        ...toLangChainMessages(history ?? []),
        new HumanMessage(question),
      ]);
      return extractText(response.content).trim();
    },
    {
      name: LLM_KNOWLEDGE_TOOL_NAME,
      description:
        "Answers a question from the language model's own general knowledge, without any search.",
      schema: z.object({
        question: z.string().describe("The user's question"),
        history: z
          .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() }))
          .optional()
          .describe("Previous messages in the conversation, oldest first"),
        userName: z.string().optional().describe("The signed-in user's name, from their account"),
        outputFile: z
          .enum([...FILE_FORMATS, ""])
          .optional()
          .describe("The user asked for the reply as a downloadable file in this format"),
        conversationSummary: z
          .string()
          .optional()
          .describe("Summary of the conversation before `history`"),
        pastConversations: z
          .string()
          .optional()
          .describe("Summaries of the user's past conversations"),
        attachedImages: z
          .string()
          .optional()
          .describe("Images attached to the question, as parsed text"),
        attachedDocuments: z
          .string()
          .optional()
          .describe("Documents attached in the conversation (whole, or summary + relevant excerpts)"),
      }),
    }
  );
}
