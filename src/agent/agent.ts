import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { APP_USER_AGENT } from "../app.js";
import {
  LocalExecutionBackend,
  type ExecutionBackend,
} from "../execution/backend.js";
import { createLLMClient, type LLMClient, type LLMProvider, type LLMEndpointConfig } from "./llm.js";
import { tools, parseAgentPayload, type ToolContext } from "./tools.js";
import { ResearchContext, type ResearchStep } from "./context.js";

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
  /**
   * Explicit run ID for this agent run (e.g. `run_20260622T173012Z_7f3a9c`).
   * Generated via createRunId() when absent; empty/whitespace-only values are
   * rejected.
   */
  runId?: string;
  /** In-memory resolved provider keys for redacting the durable agent trace. */
  onSecretsUsed?: (secrets: string[]) => void;
  /** Marks that configured provider secrets were resolved for a live search. */
  onConfiguredSecretsResolved?: () => void;
  /** Fail closed for durable agent text if configured-key resolution is incomplete. */
  onSecretCollectionIncomplete?: () => void;
}

/**
 * Generate a log-friendly agent run ID: UTC timestamp plus 3 random bytes,
 * e.g. `run_20260622T173012Z_7f3a9c`. The same ID correlates one agent run
 * across its output, steps, execution history, and usage-log entries.
 */
export function createRunId(now: Date = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  return `run_${stamp}_${randomBytes(3).toString("hex")}`;
}

interface ValidatedFetchTarget {
  url: URL;
  resolvedAddress: string;
  family: 4 | 6;
}

const MAX_FETCH_BODY_BYTES = 1024 * 1024;
const AGENT_FETCH_TIMEOUT_MS = 10000;

function isIPv4InCidr(ip: string, network: string, prefixBits: number): boolean {
  const ipOctets = ip.split(".").map(Number);
  const networkOctets = network.split(".").map(Number);

  if (
    ipOctets.length !== 4 ||
    networkOctets.length !== 4 ||
    ipOctets.some(Number.isNaN) ||
    networkOctets.some(Number.isNaN)
  ) {
    return false;
  }

  const ipValue = ipOctets.reduce((value, octet) => ((value << 8) + octet) >>> 0, 0);
  const networkValue = networkOctets.reduce(
    (value, octet) => ((value << 8) + octet) >>> 0,
    0
  );
  const mask = prefixBits === 0 ? 0 : (~((1 << (32 - prefixBits)) - 1)) >>> 0;

  return (ipValue & mask) === (networkValue & mask);
}

function extractIPv4FromMapped(address: string): string | null {
  const normalized = address.toLowerCase();

  // Dotted form: ::ffff:127.0.0.1
  const dotted = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];

  // Hex form: ::ffff:7f00:1 (127.0.0.1)
  if (!normalized.startsWith("::ffff:")) return null;
  const suffix = normalized.slice("::ffff:".length);
  const parts = suffix.split(":");
  if (parts.length !== 2) return null;

  const hi = Number.parseInt(parts[0], 16);
  const lo = Number.parseInt(parts[1], 16);
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null;

  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

function isBlockedIpAddress(address: string): boolean {
  const version = isIP(address);

  if (version === 4) {
    const blockedCidrs: Array<[string, number]> = [
      ["127.0.0.0", 8],
      ["10.0.0.0", 8],
      ["172.16.0.0", 12],
      ["192.168.0.0", 16],
      ["169.254.0.0", 16],
      ["0.0.0.0", 8],
    ];

    return blockedCidrs.some(([network, prefixBits]) =>
      isIPv4InCidr(address, network, prefixBits)
    );
  }

  if (version === 6) {
    // Check for IPv4-mapped IPv6 addresses (e.g. ::ffff:127.0.0.1)
    const mappedV4 = extractIPv4FromMapped(address);
    if (mappedV4 && isBlockedIpAddress(mappedV4)) {
      return true;
    }

    const normalized = address.toLowerCase();
    return (
      normalized === "::1" ||
      normalized === "::" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb")
    );
  }

  return false;
}

function normalizeHostname(hostname: string): string {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

function isBlockedHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "metadata.google.internal" ||
    normalized === "metadata" ||
    normalized === "169.254.169.254"
  );
}

/**
 * Agent research result.
 */
export interface AgentResult {
  answer: string;
  /** Run ID correlating this run across output, steps, and usage logs. */
  run_id: string;
  sources: Array<{
    url: string;
    title: string;
    snippet: string;
  }>;
  steps: ResearchStep[];
}

/**
 * Search Agent implementing ReAct-style reasoning.
 */
export class SearchAgent {
  private llm: LLMClient;
  private backend: ExecutionBackend;
  private noCache: boolean;
  /** Run ID fallback from construction; research() options override it. */
  private runId?: string;
  private onSecretsUsed?: (secrets: string[]) => void;
  private onConfiguredSecretsResolved?: () => void;
  private onSecretCollectionIncomplete?: () => void;

  constructor(options: AgentOptions = {}) {
    this.llm =
      options.llm ??
      createLLMClient(
        options.llmProvider ?? "isoquant",
        options.model,
        options.llmBaseUrl,
        options.llmSettings,
        options.onSecretsUsed
      );
    this.backend =
      options.executionBackend ?? new LocalExecutionBackend(options.configPath);
    this.noCache = options.noCache ?? false;
    this.runId = options.runId;
    this.onSecretsUsed = options.onSecretsUsed;
    this.onConfiguredSecretsResolved = options.onConfiguredSecretsResolved;
    this.onSecretCollectionIncomplete = options.onSecretCollectionIncomplete;
  }

  /**
   * Execute multi-step research on a goal.
   */
  async research(goal: string, options: AgentOptions = {}): Promise<AgentResult> {
    const maxSteps = options.maxSteps || 5;
    const maxSources = options.maxSources || 5;

    // An explicit run ID must be non-empty; the CLI rejects it early, but the
    // agent boundary enforces it too so library callers can't slip one through.
    const explicitRunId = options.runId ?? this.runId;
    if (
      explicitRunId !== undefined &&
      (explicitRunId.trim() === "" || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(explicitRunId))
    ) {
      throw new Error("Explicit run ID must be non-empty and contain no control characters");
    }
    // Trim surrounding whitespace so the canonical ID is stable for
    // correlation; a padded value would mismatch across logs and output.
    const runId = explicitRunId?.trim() ?? createRunId();
    const onSecretsUsed = options.onSecretsUsed ?? this.onSecretsUsed;
    const onConfiguredSecretsResolved =
      options.onConfiguredSecretsResolved ?? this.onConfiguredSecretsResolved;
    const onSecretCollectionIncomplete =
      options.onSecretCollectionIncomplete ?? this.onSecretCollectionIncomplete;
    if (onSecretsUsed) this.llm.setSecretsUsedCallback?.(onSecretsUsed);

    const context = new ResearchContext(goal, maxSources, runId);
    context.currentQuery = goal;
    const complete = async (messages: Array<{ role: "system" | "user" | "assistant"; content: string }>) => {
      try {
        return await this.llm.complete(messages);
      } catch (error) {
        // Preserve the original error class/message for CLI classification,
        // while making already-completed tool actions available for history.
        if (error && typeof error === "object") {
          try {
            Object.defineProperty(error, "agentSteps", {
              value: context.steps.map((step) => ({ ...step })),
              configurable: true,
            });
          } catch {
            // The original failure is more useful than replacing it if a
            // custom error object cannot accept trace metadata.
          }
        }
        throw error;
      }
    };

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
      const responseStartedAt = performance.now();
      const responseStartedAtWallClock = new Date();
      const response = await complete(messages);
      const content = response.content.trim();

      messages.push({ role: "assistant", content });

      const payload = parseAgentPayload(content);
      if (!payload) {
        const excerpt = content.length > 1000
          ? `${content.slice(0, 1000)}… [truncated]`
          : content;
        const rejectedStep = context.addStep(
          "rejected_action",
          `Malformed model response: ${JSON.stringify(excerpt)}`
        );
        rejectedStep.timestamp = responseStartedAtWallClock;
        context.completeStep(
          rejectedStep,
          "failed",
          performance.now() - responseStartedAt,
          "Model response was not valid agent JSON"
        );
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
          run_id: runId,
          sources: result.sources,
          steps: result.steps,
        };
      }

      const tool = tools[payload.tool];
      if (!tool) {
        const action = JSON.stringify(payload);
        const excerpt = action.length > 1000
          ? `${action.slice(0, 1000)}… [truncated]`
          : action;
        const rejectedStep = context.addStep(
          "rejected_action",
          `Unknown tool action: ${excerpt}`
        );
        rejectedStep.timestamp = responseStartedAtWallClock;
        context.completeStep(
          rejectedStep,
          "failed",
          performance.now() - responseStartedAt,
          `Unknown tool: ${JSON.stringify(payload.tool)}`
        );
        messages.push({
          role: "user",
          content: `Unknown tool: ${payload.tool}. Available: search, fetch, refine`,
        });
        continue;
      }

      // Execute tool
      const agentStep = context.addStep(tool.name as any, JSON.stringify(payload));
      const stepStartedAt = performance.now();
      let toolFailed = false;
      let reportedToolFailure: string | undefined;
      
      const toolContext: ToolContext = {
        query: context.currentQuery,
        llm: this.llm,
        searchFn: async (q: string) => {
          const result = await this.backend.search(q, {
            limit: 5,
            limitSet: false,
            rerankStrategy: "rrf",
            noCache: this.noCache,
            runId,
            onSecretsUsed: (secrets) => onSecretsUsed?.(secrets),
            onConfiguredSecretsResolved,
            onSecretCollectionIncomplete,
          });
          // Track sources
          result.results.forEach((r) => context.addSource(r));
          return result.results;
        },
        fetchFn: this.fetchContent.bind(this),
        onToolFailure: (error) => {
          toolFailed = true;
          reportedToolFailure = error instanceof Error ? error.message : String(error);
        },
      };

      try {
        const toolResult = await tool.execute(toolContext, ...payload.args);
        context.completeStep(
          agentStep,
          toolFailed ? "failed" : "success",
          performance.now() - stepStartedAt,
          reportedToolFailure
        );
        messages.push({ role: "user", content: `Result:\n${toolResult}` });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        context.completeStep(agentStep, "failed", performance.now() - stepStartedAt, message);
        messages.push({
          role: "user",
          content: `Error: ${message}`,
        });
      }
    }

    // Max steps reached - synthesize what we have
    const finalResponse = await complete([
      ...messages,
      {
        role: "user",
        content: "Maximum steps reached. Please provide a FINAL ANSWER based on the information gathered.",
      },
    ]);

    let finalPayload = parseAgentPayload(finalResponse.content);
    if (!finalPayload || finalPayload.type !== "final") {
      const retryResponse = await complete([
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
      run_id: runId,
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

  private async validateFetchUrl(url: string): Promise<ValidatedFetchTarget> {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new Error(`Invalid fetch URL: ${url}`);
    }

    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      throw new Error(`Unsupported fetch URL protocol: ${parsedUrl.protocol}`);
    }

    const host = normalizeHostname(parsedUrl.hostname);

    if (isBlockedHostname(host)) {
      throw new Error(`Refusing to fetch internal hostname: ${host}`);
    }

    if (isBlockedIpAddress(host)) {
      throw new Error(`Refusing to fetch non-public IP: ${host}`);
    }

    const resolvedAddresses = await lookup(host, { all: true, verbatim: true });
    if (resolvedAddresses.some((entry) => isBlockedIpAddress(entry.address))) {
      throw new Error(
        `Refusing to fetch hostname resolving to a non-public IP: ${parsedUrl.hostname}`
      );
    }

    const preferredAddress = resolvedAddresses.find(
      (entry): entry is { address: string; family: 4 | 6 } => entry.family === 4 || entry.family === 6
    );

    if (!preferredAddress) {
      throw new Error(`Unable to resolve a public IP for hostname: ${parsedUrl.hostname}`);
    }

    return {
      url: parsedUrl,
      resolvedAddress: preferredAddress.address,
      family: preferredAddress.family,
    };
  }

  private async fetchValidatedBody(target: ValidatedFetchTarget): Promise<{ contentType: string; body: string }> {
    const client = target.url.protocol === "https:" ? https : http;

    return await new Promise((resolve, reject) => {
      const request = client.request(
        {
          protocol: target.url.protocol,
          hostname: target.url.hostname,
          port: target.url.port || undefined,
          method: "GET",
          path: `${target.url.pathname}${target.url.search}`,
          headers: {
            "User-Agent": `Mozilla/5.0 (compatible; ${APP_USER_AGENT})`,
            Accept: "text/html, application/xhtml+xml, text/plain;q=0.9",
            "Accept-Encoding": "identity",
          },
          servername: target.url.hostname,
          lookup: (_hostname, _options, callback) => {
            callback(null, target.resolvedAddress, target.family);
          },
        },
        (response) => {
          const statusCode = response.statusCode ?? 0;
          if (statusCode < 200 || statusCode >= 300) {
            response.resume();
            reject(new Error(`Agent fetch failed with HTTP ${statusCode}`));
            return;
          }

          const contentType = response.headers["content-type"] || "";
          const normalizedContentType = Array.isArray(contentType) ? contentType[0] || "" : contentType;
          if (
            !normalizedContentType.includes("text/html") &&
            !normalizedContentType.includes("application/xhtml+xml") &&
            !normalizedContentType.startsWith("text/")
          ) {
            response.resume();
            reject(new Error(`Unsupported fetch content type: ${normalizedContentType || "unknown"}`));
            return;
          }

          const chunks: Buffer[] = [];
          let totalBytes = 0;

          response.on("data", (chunk: Buffer) => {
            totalBytes += chunk.length;
            if (totalBytes > MAX_FETCH_BODY_BYTES) {
              response.destroy(new Error(`Agent fetch exceeded ${MAX_FETCH_BODY_BYTES} bytes`));
              return;
            }

            chunks.push(chunk);
          });

          response.on("end", () => {
            resolve({
              contentType: normalizedContentType,
              body: Buffer.concat(chunks).toString("utf8"),
            });
          });

          response.on("error", reject);
        }
      );

      request.setTimeout(AGENT_FETCH_TIMEOUT_MS, () => {
        request.destroy(new Error(`Agent fetch timed out after ${AGENT_FETCH_TIMEOUT_MS}ms`));
      });
      request.on("error", reject);
      request.end();
    });
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
