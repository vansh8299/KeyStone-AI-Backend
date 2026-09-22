import { TavilySearch } from "@langchain/tavily";
import { env } from "../../../../config/env";

export const WEB_SEARCH_TOOL_NAME = "tavily_search";

export function createWebSearchTool() {
  if (!env.tavilyApiKey) {
    throw new Error("TAVILY_API_KEY is required to use the web search tool");
  }

  return new TavilySearch({
    tavilyApiKey: env.tavilyApiKey,
    maxResults: 5,
  });
}
