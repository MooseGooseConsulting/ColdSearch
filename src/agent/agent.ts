import { APP_USER_AGENT } from "../app.js";
import { requestValidated, validateFetchUrl, type ValidatedFetchTarget } from "../safe-fetch.js";
import {
  LocalExecutionBackend,
  type ExecutionBackend,
} from "../execution/backend.js";
import { createLLMClient, type LLMClient, type LLMProvider, type LLMEndpointConfig } from "./llm.js";
import { tools, parseAgentPayload } from "./tools.js";
import { ResearchContext } from "./context.js";

/**
 * Agent configuration options.
 */
export interface AgentOptions {
  /** Maximum research steps */
  maxSteps?: number;
  /** Maximum sources to collect */
  maxSources?: number;
  /** LLM provider (OpenAI-compatible) */
  llmProvider?: LLMProvider;
  /** LLM model */
  model?: string;
  /** Override LLM API base URL (OpenAI-compatible /chat/completions) */
  llmBaseUrl?: string;
  llmSettings?: LLMEndpointConfig;
  /** Config path */
  configPath?: string;
  /** Execution backend implementation */
  executionBackend?: ExecutionBackend;
  /** Optional injected LLM (tests); defaults to createLLMClient() */
  llm?: LLMClient;
  /** Bypass the result cache for the agent's internal searches */
  noCache?: boolean;
}

const MAX_FETCH_BODY_BYTES = 1024 * 1024;
const AGENT_FETCH_TIMEOUT_MS = 10000;

/**
 * Agent research result.
 */
export interface AgentResult {
  answer: string;
  sources: Array<{
    url: string;
    title: string;
    snippet: string;
  }>;
  steps: Array<{
    type: string;
    description: string;
    timestamp: Date;
  }>;
}

/**
 * Search Agent implementing ReAct-style reasoning.
 */
export class SearchAgent {
  private llm: LLMClient;
  private backend: ExecutionBackend;
  private noCache: boolean;

  constructor(options: AgentOptions = {}) {
    this.llm =
      options.llm ??
      createLLMClient(
        options.llmProvider ?? "isoquant",
        options.model,
        options.llmBaseUrl,
        options.llmSettings
      );
    this.backend =
      options.executionBackend ?? new LocalExecutionBackend(options.configPath);
    this.noCache = options.noCache ?? false;
  }

  /**
   * Execute multi-step research on a goal.
   */
  async research(goal: string, options: AgentOptions = {}): Promise<AgentResult> {
    const maxSteps = options.maxSteps || 5;
    const maxSources = options.maxSources || 5;
    
    const context = new ResearchContext(goal, maxSources);
    context.currentQuery = goal;

    const systemPrompt = `You are a research assistant that helps users find information. You have access to these tools:

- search("query"): Search the web for information
- fetch("url"): Fetch content from a URL  
- refine("current query", "intent"): Generate a better search query

Your task is to research the user's goal and provide a comprehensive answer. Follow this process:

1. SEARCH for initial information about the topic
2. FETCH promising sources to read more details
3. REFINE your search query if needed to find better information
4. Repeat steps 1-3 until you have sufficient information (max ${maxSteps} steps)
5. SYNTHESIZE a final answer with citations

When you want to use a tool, respond with ONLY a JSON object in this format:
{"type":"tool","tool":"search","args":["your query"]}

When you have enough information, respond with ONLY a JSON object in this format:
{"type":"final","answer":"Your comprehensive answer here with citations [1], [2], etc."}

Be thorough but efficient. Focus on authoritative sources.`;

    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Research this goal: ${goal}` },
    ];

    for (let step = 0; step < maxSteps; step++) {
      // Get agent's next action
      const response = await this.llm.complete(messages);
      const content = response.content.trim();

      messages.push({ role: "assistant", content });

      const payload = parseAgentPayload(content);
      if (!payload) {
        messages.push({
          role: "user",
          content:
            'Invalid format. Respond with JSON only, using either {"type":"tool","tool":"search","args":["query"]} or {"type":"final","answer":"..."}',
        });
        continue;
      }

      if (payload.type === "final") {
        const result = context.generateResponse(payload.answer);
        return {
          answer: result.answer,
          sources: result.sources,
          steps: result.steps,
        };
      }

      const tool = tools[payload.tool];
      if (!tool) {
        messages.push({
          role: "user",
          content: `Unknown tool: ${payload.tool}. Available: search, fetch, refine`,
        });
        continue;
      }

      // Execute tool
      context.addStep(tool.name as any, JSON.stringify(payload));
      
      const toolContext = {
        query: context.currentQuery,
        llm: this.llm,
        searchFn: async (q: string) => {
          const result = await this.backend.search(q, {
            limit: 5,
            limitSet: false,
            rerankStrategy: "rrf",
            noCache: this.noCache,
          });
          // Track sources
          result.results.forEach((r) => context.addSource(r));
          return result.results;
        },
        fetchFn: this.fetchContent.bind(this),
      };

      try {
        const toolResult = await tool.execute(toolContext, ...payload.args);
        messages.push({ role: "user", content: `Result:\n${toolResult}` });
      } catch (error) {
        messages.push({
          role: "user",
          content: `Error: ${(error as Error).message}`,
        });
      }
    }

    // Max steps reached - synthesize what we have
    const finalResponse = await this.llm.complete([
      ...messages,
      {
        role: "user",
        content: "Maximum steps reached. Please provide a FINAL ANSWER based on the information gathered.",
      },
    ]);

    let finalPayload = parseAgentPayload(finalResponse.content);
    if (!finalPayload || finalPayload.type !== "final") {
      const retryResponse = await this.llm.complete([
        ...messages,
        {
          role: "user",
          content:
            'Respond now with FINAL JSON only in the format {"type":"final","answer":"..."}. Do not call tools.',
        },
      ]);
      finalPayload = parseAgentPayload(retryResponse.content);
    }

    const answer = finalPayload?.type === "final"
      ? finalPayload.answer
      : "Research completed, but the model did not produce a final structured answer.";

    const result = context.generateResponse(answer);
    return {
      answer: result.answer,
      sources: result.sources,
      steps: result.steps,
    };
  }

  /**
   * Fetch content from a URL.
   */
  private async fetchContent(url: string): Promise<string> {
    const target = await this.validateFetchUrl(url);
    const { contentType, body } = await this.fetchValidatedBody(target);

    if (contentType.includes("text/html") || contentType.includes("application/xhtml+xml")) {
      return this.extractTextFromHTML(body);
    }

    if (contentType.startsWith("text/")) {
      return body;
    }

    throw new Error(`Unsupported fetch content type: ${contentType || "unknown"}`);
  }

  /** The SSRF guard of ADR 004; the checks themselves live in `src/safe-fetch.ts`. */
  private async validateFetchUrl(url: string): Promise<ValidatedFetchTarget> {
    return validateFetchUrl(url);
  }

  private async fetchValidatedBody(target: ValidatedFetchTarget): Promise<{ contentType: string; body: string }> {
    let contentType = "";
    const response = await requestValidated(target, {
      label: "Agent fetch",
      headers: {
        "User-Agent": `Mozilla/5.0 (compatible; ${APP_USER_AGENT})`,
        Accept: "text/html, application/xhtml+xml, text/plain;q=0.9",
        "Accept-Encoding": "identity",
      },
      timeoutMs: AGENT_FETCH_TIMEOUT_MS,
      maxBytes: MAX_FETCH_BODY_BYTES,
      overflow: "error",
      // Redirects are not followed here: a 3xx is a non-2xx and is refused.
      inspect: (statusCode, headers) => {
        if (statusCode < 200 || statusCode >= 300) {
          throw new Error(`Agent fetch failed with HTTP ${statusCode}`);
        }
        const header = headers["content-type"] || "";
        contentType = Array.isArray(header) ? header[0] || "" : header;
        if (
          !contentType.includes("text/html") &&
          !contentType.includes("application/xhtml+xml") &&
          !contentType.startsWith("text/")
        ) {
          throw new Error(`Unsupported fetch content type: ${contentType || "unknown"}`);
        }
      },
    });
    return { contentType, body: response.body.toString("utf8") };
  }

  /**
   * Simple HTML to text extraction.
   */
  private extractTextFromHTML(html: string): string {
    // Remove script and style tags
    let text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
    
    // Replace common block elements with newlines
    text = text
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/div>/gi, "\n")
      .replace(/<\/h[1-6]>/gi, "\n\n");
    
    // Remove remaining tags
    text = text.replace(/<[^>]+>/g, "");
    
    // Decode entities
    text = text
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, " ");
    
    // Normalize whitespace
    text = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join("\n");
    
    return text;
  }
}
