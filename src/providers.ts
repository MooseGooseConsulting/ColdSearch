import { BraveAdapter } from "./adapters/brave.js";
import { BrightDataAdapter } from "./adapters/brightdata.js";
import { ExaAdapter } from "./adapters/exa.js";
import { FirecrawlAdapter } from "./adapters/firecrawl.js";
import { JinaAdapter } from "./adapters/jina.js";
import { SearXNGAdapter } from "./adapters/searxng.js";
import { SerperAdapter } from "./adapters/serper.js";
import { TavilyAdapter } from "./adapters/tavily.js";
import { installBrightDataToolProfiles } from "./registry/brightdata-tool-profiles.js";
import { resolveEligibleTools } from "./registry/tool-profiles.js";
import type { CapabilityName, Config } from "./types.js";
import type { SearchAdapter } from "./types.js";

// Keep the existing provider-tool registry as the shared runtime object while
// Bright Data profiles live in a smaller provider-specific module.
installBrightDataToolProfiles();

export interface ProviderMetadata {
  displayName: string;
  capabilities: CapabilityName[];
  selfHosted?: boolean;
  optionKeys?: string[];
  createAdapter: () => SearchAdapter;
}

export const providerRegistry = {
  tavily: {
    displayName: "Tavily",
    capabilities: ["search", "extract", "crawl"],
    createAdapter: () => new TavilyAdapter(),
  },
  brave: {
    displayName: "Brave",
    capabilities: ["search"],
    createAdapter: () => new BraveAdapter(),
  },
  brightdata: {
    displayName: "Bright Data",
    capabilities: ["search", "extract"],
    optionKeys: [
      "serpZone",
      "unlockerZone",
      "searchEngine",
      "searchCountry",
      "maxStructuredInputsPerCall",
      "unlockerTimeoutMs",
      "maxDiscoveryResultsPerInput",
    ],
    createAdapter: () => new BrightDataAdapter(),
  },
  exa: {
    displayName: "Exa",
    capabilities: ["search", "extract", "crawl"],
    createAdapter: () => new ExaAdapter(),
  },
  serper: {
    displayName: "Serper",
    capabilities: ["search"],
    createAdapter: () => new SerperAdapter(),
  },
  jina: {
    displayName: "Jina",
    capabilities: ["extract"],
    createAdapter: () => new JinaAdapter(),
  },
  firecrawl: {
    displayName: "Firecrawl",
    capabilities: ["search", "extract", "crawl"],
    createAdapter: () => new FirecrawlAdapter(),
  },
  searxng: {
    displayName: "SearXNG",
    capabilities: ["search"],
    selfHosted: true,
    optionKeys: ["baseUrl"],
    createAdapter: () => new SearXNGAdapter(),
  },
} satisfies Record<string, ProviderMetadata>;

export type ProviderName = keyof typeof providerRegistry;

export function listRegisteredProviders(): ProviderName[] {
  return Object.keys(providerRegistry) as ProviderName[];
}

export function getProviderMetadata(provider: string): ProviderMetadata {
  const metadata = providerRegistry[provider as ProviderName];
  if (!metadata) {
    throw new Error(`Unknown provider: ${provider}`);
  }
  return metadata;
}

export function providerSupportsCapability(
  provider: string,
  capability: CapabilityName
): boolean {
  return getProviderMetadata(provider).capabilities.includes(capability);
}

export function createRegisteredAdapter(provider: string): SearchAdapter {
  return getProviderMetadata(provider).createAdapter();
}

/** Validate an explicit provider selection without applying routing strategy. */
export function validateSelectedProviders(
  config: Config,
  capability: CapabilityName,
  providers: readonly string[]
): void {
  for (const provider of providers) {
    if (!config.providers[provider]) {
      throw new Error(`Provider '${provider}' is not configured`);
    }
    if (!providerSupportsCapability(provider, capability)) {
      throw new Error(`Provider '${provider}' does not implement capability '${capability}'`);
    }
  }
}

/** No provider survives an intent feature filter; retain exclusions for audit history. */
export class NoEligibleProviderFeatureError extends Error {
  constructor(readonly skippedProviders: Record<string, string>, message: string) {
    super(message);
    this.name = "NoEligibleProviderFeatureError";
  }
}

/**
 * Shared provider resolution logic used by both CLI dry-run and FanoutEngine.
 * Validates config/capability and applies strategy (all vs random), including
 * the conditional quota-recovery scope for random/single-provider execution.
 *
 * When `requireFeatures` is supplied, routing becomes requirement-aware: the
 * selected providers are narrowed to those whose wired tool for the capability
 * actually sets every requested feature predicate (see
 * `src/registry/tool-profiles.ts`). This prevents picking a provider that
 * "claims the category" but cannot honor the requested feature. The same
 * eligibility filter applies to both initial selection and quota alternatives.
 */
export function resolveCapabilityProviders(
  config: Config,
  capability: CapabilityName,
  options: { providers?: string[]; singleProvider?: boolean; requireFeatures?: string[] }
): {
  providers: string[];
  quotaFallbackProviders?: string[];
  skippedProviders: Record<string, string>;
} {
  const capConfig = config.capabilities[capability];
  if (!capConfig) {
    throw new Error(`No configuration found for capability: ${capability}`);
  }

  const selected = options.providers && options.providers.length > 0
    ? options.providers
    : capConfig.providers;

  if (!selected.length) {
    throw new Error(`No providers configured for ${capability}`);
  }

  validateSelectedProviders(config, capability, selected);

  let eligible = selected;
  const skippedProviders: Record<string, string> = {};
  if (options.requireFeatures && options.requireFeatures.length > 0) {
    const eligibleProviders = new Set(
      resolveEligibleTools(capability, { requireFeatures: options.requireFeatures }).map(
        (tool) => tool.provider
      )
    );
    eligible = selected.filter((provider) => eligibleProviders.has(provider));
    for (const provider of selected) {
      if (!eligibleProviders.has(provider)) {
        skippedProviders[provider] =
          `does not satisfy required features: [${options.requireFeatures.join(", ")}]`;
      }
    }
    if (!eligible.length) {
      throw new NoEligibleProviderFeatureError(
        skippedProviders,
        `No '${capability}' provider tool satisfies required features: ` +
          `[${options.requireFeatures.join(", ")}] (from [${selected.join(", ")}])`
      );
    }
  }

  const useSingleProvider = options.singleProvider || capConfig.strategy === "random";
  if (!useSingleProvider) return { providers: eligible, skippedProviders };

  const randomIndex = Math.floor(Math.random() * eligible.length);
  const first = eligible[randomIndex];
  return {
    providers: [first],
    skippedProviders,
    // Keep normal random execution to one provider. Only an account-quota
    // rejection unlocks these alternatives; never leave the eligible scope or
    // revisit the selected provider (including duplicate pool entries).
    quotaFallbackProviders: [...new Set(eligible.filter((provider) => provider !== first))],
  };
}
