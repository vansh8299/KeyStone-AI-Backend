import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { AIMessage } from "@langchain/core/messages";
import type { ChatGeneration, LLMResult } from "@langchain/core/outputs";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/**
 * Adds up the tokens of every LLM call made while it's attached to a run — the routing,
 * clarification, answer and review calls of one chat turn all count towards that response.
 * Providers that report no usage for a call add nothing.
 */
export class TokenUsageTracker extends BaseCallbackHandler {
  name = "token_usage_tracker";
  private usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  private reported = false;

  handleLLMEnd(output: LLMResult) {
    let input = 0;
    let out = 0;
    for (const generation of output.generations.flat()) {
      const usage = ((generation as ChatGeneration).message as AIMessage | undefined)?.usage_metadata;
      if (usage) {
        input += usage.input_tokens ?? 0;
        out += usage.output_tokens ?? 0;
      }
    }
    // Some providers report usage only on the call as a whole.
    if (input === 0 && out === 0) {
      const fallback = output.llmOutput?.tokenUsage ?? output.llmOutput?.estimatedTokenUsage;
      input = fallback?.promptTokens ?? 0;
      out = fallback?.completionTokens ?? 0;
    }
    if (input === 0 && out === 0) return;
    this.reported = true;
    this.usage.inputTokens += input;
    this.usage.outputTokens += out;
    this.usage.totalTokens += input + out;
  }

  /** The totals so far, or null when no call reported its usage. */
  total(): TokenUsage | null {
    return this.reported ? { ...this.usage } : null;
  }
}
