/**
 * LLM client interface for the search agent.
 * OpenAI-compatible HTTP only — ColdSearch does not call the Anthropic API.
 */
import { KeyPoolManager } from "../engine/keypool.js";
import { APP_USER_AGENT } from "../app.js";
import { fetchJson } from "../http.js";

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export const REASONING_EFFORTS = ["none", "low", "medium", "high", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface LLMOptions {
  reasoningEffort?: ReasoningEffort;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface LLMResponse {
  content: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/**
 * LLM client interface.
 */
export interface LLMClient {
  complete(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse>;
}

/**
 * Supported OpenAI-compatible LLM providers. Single source of truth for the
 * accepted `--llm` / `[agent.llm] provider` values.
 */
export const LLM_PROVIDERS = ["openai", "groq", "openrouter", "cerebras", "xai", "isoquant"] as const;
export type LLMProvider = (typeof LLM_PROVIDERS)[number];

/** OpenAI-compatible LLM endpoint settings; subset of `[agent.llm]` in TOML. */
export interface LLMEndpointConfig {
  provider?: LLMProvider;
  model?: string;
  baseUrl?: string;
  reasoningEffort?: ReasoningEffort;
  /** Secret NAME reference, never a literal credential. */
  keyRef?: string;
}

/**
 * Resolve the effective agent LLM endpoint with CLI-flag precedence:
 *
 *   CLI flags (--llm / --model / --llm-base-url)
 *     > TOML `[agent.llm]`
 *     > environment fallback and code defaults (applied by createLLMClient)
 *
 * Pure and synchronous so precedence is testable without any network call.
 */
export function resolveLlmConfig(
  cli: LLMEndpointConfig,
  toml?: LLMEndpointConfig
): LLMEndpointConfig {
  return {
    provider: cli.provider ?? toml?.provider,
    model: cli.model ?? toml?.model,
    baseUrl: cli.baseUrl ?? toml?.baseUrl,
    reasoningEffort: cli.reasoningEffort ?? toml?.reasoningEffort,
    keyRef: cli.keyRef ?? toml?.keyRef,
  };
}

const PROVIDER_ALIASES: Record<
  Exclude<LLMProvider, "openai">,
  { baseUrl: string; defaultModel: string; envKey: string }
> = {
  groq: {
    baseUrl: "https://api.groq.com/openai/v1",
    // Default models verified against live provider APIs on 2026-05-28; override with --model.
    defaultModel: "llama-3.3-70b-versatile",
    envKey: "GROQ_API_KEY",
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openrouter/free",
    envKey: "OPENROUTER_API_KEY",
  },
  cerebras: {
    baseUrl: "https://api.cerebras.ai/v1",
    // Cerebras retired its Llama lineup; gpt-oss-120b is the available model that
    // returns usable message.content (zai-glm-4.7 emits reasoning-only / empty content).
    defaultModel: "gpt-oss-120b",
    envKey: "CEREBRAS_API_KEY",
  },
  isoquant: {
    baseUrl: "https://api.isoquant.ai/v1",
    defaultModel: "glm-5.3-flash",
    envKey: "ISOQUANT_API_KEY",
  },
  xai: {
    baseUrl: "https://api.x.ai/v1",
    defaultModel: "grok-3",
    envKey: "XAI_GROK_API_KEY",
  },
};

/**
 * OpenAI-compatible chat completions client.
 */
export class OpenAIClient implements LLMClient {
  private apiKey: string;
  private defaultModel: string;
  private baseUrl: string;
  private keyPool?: KeyPoolManager;
  private settings: LLMEndpointConfig;

  constructor(apiKey: string, model = "gpt-4o", baseUrl = "https://api.openai.com/v1", settings: LLMEndpointConfig = {}) {
    this.settings = settings;
    if (settings.keyRef !== undefined) {
      if (!/^(env:|doppler:)[A-Za-z_][A-Za-z0-9_]*$/.test(settings.keyRef)) {
        throw new Error("Agent LLM key_ref must be an env: or doppler: secret name");
      }
      this.keyPool = new KeyPoolManager();
      this.keyPool.register("agent-llm", { keys: [settings.keyRef] });
    }
    if (settings.reasoningEffort !== undefined && !REASONING_EFFORTS.includes(settings.reasoningEffort)) {
      throw new Error("Invalid agent LLM reasoning effort");
    }
    this.apiKey = apiKey;
    this.defaultModel = model;
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  private chatCompletionsUrl(): string {
    const normalized = this.baseUrl.replace(/\/$/, "");
    if (normalized.endsWith("/chat/completions")) {
      return normalized;
    }
    return `${normalized}/chat/completions`;
  }

  async complete(
    messages: LLMMessage[],
    options: LLMOptions = {}
  ): Promise<LLMResponse> {
    // Doppler-injected env values also work without the Doppler CLI on CI.
    const ref = this.settings.keyRef;
    const injectedKey = ref?.startsWith("doppler:") ? process.env[ref.slice(8)] : undefined;
    const apiKey = this.keyPool ? (injectedKey || await this.keyPool.getNextKey("agent-llm")) : this.apiKey;
    const effort = options.reasoningEffort ?? this.settings.reasoningEffort;
    const reasoning = effort === undefined ? {} : this.settings.provider === "openrouter"
      ? { reasoning: { effort } }
      : { reasoning_effort: effort };
    const data = await fetchJson<{
      choices?: Array<{ message?: { content?: string } }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
    }>(this.chatCompletionsUrl(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": APP_USER_AGENT,
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          ...reasoning,
          model: options.model || this.defaultModel,
          messages,
          temperature: options.temperature ?? 0.2,
          max_tokens: options.maxTokens,
        }),
      },
      {
        label: "OpenAI completion",
      }
    );

    return {
      content: data.choices?.[0]?.message?.content || "",
      usage: data.usage
        ? {
            promptTokens: data.usage.prompt_tokens ?? 0,
            completionTokens: data.usage.completion_tokens ?? 0,
            totalTokens:
              data.usage.total_tokens ??
              ((data.usage.prompt_tokens ?? 0) +
                (data.usage.completion_tokens ?? 0)),
          }
        : undefined,
    };
  }
}

function resolveOpenAiBaseUrl(baseUrl?: string): string {
  return (
    baseUrl?.trim() ||
    process.env.OPENAI_BASE_URL?.trim() ||
    "https://api.openai.com/v1"
  ).replace(/\/$/, "");
}

/**
 * Create an LLM client from environment.
 * Anthropic is intentionally unsupported — do not add api.anthropic.com calls here.
 */
export function createLLMClient(
  provider: LLMProvider = "isoquant",
  model?: string,
  baseUrl?: string,
  settings: LLMEndpointConfig = {}
): LLMClient {
  if (provider === "openai") {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey && !settings.keyRef) {
      throw new Error("OPENAI_API_KEY environment variable not set");
    }
    return new OpenAIClient(apiKey || "", model, resolveOpenAiBaseUrl(baseUrl), { ...settings, provider });
  }

  const alias = PROVIDER_ALIASES[provider as Exclude<LLMProvider, "openai">];
  if (!alias) {
    throw new Error(
      `Unsupported LLM provider "${provider}". Supported: ${LLM_PROVIDERS.join(", ")}.`
    );
  }

  const apiKey = process.env[alias.envKey];
  const keyRef = settings.keyRef ?? (provider === "isoquant" ? "doppler:ISOQUANT_API_KEY" : undefined);
  if (!apiKey && !keyRef) {
    throw new Error(`${alias.envKey} environment variable not set`);
  }
  return new OpenAIClient(
    apiKey || "",
    model || alias.defaultModel,
    baseUrl || alias.baseUrl,
    { ...settings, provider, keyRef, reasoningEffort: settings.reasoningEffort ?? (provider === "isoquant" ? "medium" : undefined) }
  );
}
