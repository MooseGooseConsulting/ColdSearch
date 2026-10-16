import {
  listToolProfiles,
  toolSatisfiesRequirements,
} from "../registry/tool-profiles.js";
import type {
  CapabilityCategory,
  CapabilityName,
  CommonOptions,
  Config,
  SemanticFit,
  ToolExecutionMode,
  ToolWiringStatus,
} from "../types.js";

/**
 * Intent layer (issue #79, Section B).
 *
 * An intent is the portable user/agent goal ("find links about X", "pull the
 * content behind this URL") that a capability command backs. Intents are
 * resolved against the provider-tool registry BEFORE any dispatch so that an
 * unroutable intent fails before the first network call, with a structured,
 * machine-readable rejection instead of a provider error.
 */

export type SearchIntent =
  | "web-link-search"
  | "content-backed-retrieval"
  | "url-similarity"
  | "known-url-extraction"
  | "structured-extraction"
  | "url-discovery-map"
  | "crawl"
  | "answer"
  | "research";

export interface IntentDef {
  category: CapabilityCategory;
  /**
   * Feature predicates an eligible tool must set (see
   * ProviderToolProfile.features). Threaded into routing as
   * `requireFeatures` so provider selection is requirement-aware.
   */
  requireFeatures?: string[];
  /**
   * Restrict eligibility to one provider-native tool (matched by provider +
   * adapterMethod) when the intent is not generalizable across providers.
   */
  nativeOnly?: { provider: string; adapterMethod: string };
  /** Surfaced on every eligibility entry and rendered by the CLI. */
  deprecation?: string;
  notes?: string;
}

export const INTENT_DEFS: Record<SearchIntent, IntentDef> = {
  "web-link-search": {
    category: "search",
    notes: "Plain ranked web links; the default behind the search command.",
  },
  "content-backed-retrieval": {
    category: "search",
    // The common option is `includeContent`; the registry feature predicate
    // that backs it is `integratedContent` (see src/registry/tool-profiles.ts).
    requireFeatures: ["integratedContent"],
    notes:
      "Results must carry page content, not just links (common option " +
      "`includeContent`, profile feature predicate `integratedContent`).",
  },
  "url-similarity": {
    category: "search",
    nativeOnly: { provider: "exa", adapterMethod: "findSimilar" },
    deprecation:
      "exa findSimilar is deprecated upstream (OpenAPI-marked in the " +
      "2026-10-12 audit) but still callable; prefer describing the source " +
      "page in exa /search.",
    notes: "Semantic neighbors of a known URL — unique to exa findSimilar.",
  },
  "known-url-extraction": {
    category: "extract",
    notes: "Content retrieval for a URL the caller already has.",
  },
  "structured-extraction": {
    category: "extract",
    requireFeatures: ["structuredExtraction"],
    notes:
      "Schema/prompt-driven structured extraction. No wired extract tool " +
      "sets the `structuredExtraction` predicate yet (firecrawl.extract is " +
      "documented but unwired), so this intent rejects until one lands.",
  },
  "url-discovery-map": {
    category: "map",
    notes: "URL discovery over a site; returns URLs, not page content.",
  },
  crawl: {
    category: "crawl",
    notes: "Site traversal with extracted content; the default behind crawl.",
  },
  answer: {
    category: "answer",
    notes: "Synthesized answer generation, distinct from raw search.",
  },
  research: {
    category: "research",
    notes: "Multi-step/deep research surfaces (e.g. exa type=deep, tavily /research).",
  },
};

const SEARCH_INTENT_IDS = Object.keys(INTENT_DEFS) as SearchIntent[];

export function listSearchIntents(): SearchIntent[] {
  return SEARCH_INTENT_IDS;
}

export function isSearchIntent(value: string): value is SearchIntent {
  return Object.hasOwn(INTENT_DEFS, value);
}

/** One registry tool that can (or could, if wired) back an intent. */
export interface IntentEligibility {
  /** Registry provider key, e.g. "exa". */
  provider: string;
  /** ColdSearch-facing tool id, e.g. "findSimilar". */
  tool: string;
  /** Stable id `<provider>.<tool>`. */
  id: string;
  /** Provider docs/API name, e.g. "POST /findSimilar". */
  nativeName: string;
  /** Fit of this tool's view over the intent's category. */
  semanticFit: SemanticFit | null;
  executionMode: ToolExecutionMode;
  status: ToolWiringStatus;
  /** True when the provider is in the effective pool (including a CLI override). */
  inConfiguredPool: boolean;
  deprecation?: string;
}

export interface IntentResolution {
  intent: SearchIntent;
  category: CapabilityCategory;
  /** Provider used by a native-only intent, when the intent requires one. */
  nativeOnlyProvider?: string;
  requireFeatures?: string[];
  /** Wired normalized tools, sorted direct > partial > derived > not-recommended. */
  eligible: IntentEligibility[];
  /** Tools without a wired normalized path (direct substrate or available/deferred). */
  documentedOnly: IntentEligibility[];
  /** The effective provider pool, using a CLI override when supplied. */
  configuredProviders: string[];
  /** Eligible providers intersected with the configured pool (actual routing). */
  routedProviders: string[];
}

const FIT_RANK: Record<SemanticFit, number> = {
  direct: 0,
  partial: 1,
  derived: 2,
  "not-recommended": 3,
};

function eligibilityRank(entry: IntentEligibility): number {
  return entry.semanticFit === null ? FIT_RANK["not-recommended"] + 1 : FIT_RANK[entry.semanticFit];
}

/**
 * Resolve an intent against the provider-tool registry and effective routing pool.
 * Pure and offline: no network, no key resolution.
 */
export function resolveIntent(
  intent: SearchIntent,
  config: Config,
  providerOverride?: string[]
): IntentResolution {
  const def = INTENT_DEFS[intent];
  const configuredProviders =
    providerOverride ?? config.capabilities[def.category]?.providers ?? [];
  const configuredPool = new Set(configuredProviders);

  const eligible: IntentEligibility[] = [];
  const documentedOnly: IntentEligibility[] = [];

  for (const profile of listToolProfiles({ category: def.category })) {
    if (
      def.nativeOnly &&
      (profile.provider !== def.nativeOnly.provider ||
        profile.adapterMethod !== def.nativeOnly.adapterMethod)
    ) {
      continue;
    }
    if (!toolSatisfiesRequirements(profile, { requireFeatures: def.requireFeatures })) {
      continue;
    }

    const entry: IntentEligibility = {
      provider: profile.provider,
      tool: profile.tool,
      id: `${profile.provider}.${profile.tool}`,
      nativeName: profile.nativeName,
      semanticFit:
        profile.commonViews.find((view) => view.category === def.category)?.semanticFit ??
        null,
      executionMode: profile.execution.mode,
      status: profile.status,
      inConfiguredPool: configuredPool.has(profile.provider),
      ...(def.deprecation ? { deprecation: def.deprecation } : {}),
    };

    // Intent routing feeds the normalized capability engine, which dispatches
    // only adapter-backed tools. Direct profiles remain callable through the
    // substrate, but cannot back normalized intent routing.
    if (profile.status === "wired") {
      eligible.push(entry);
    } else {
      documentedOnly.push(entry);
    }
  }

  eligible.sort((a, b) => eligibilityRank(a) - eligibilityRank(b) || a.id.localeCompare(b.id));
  documentedOnly.sort((a, b) => a.id.localeCompare(b.id));

  const eligibleProviders = new Set(eligible.map((entry) => entry.provider));
  return {
    intent,
    category: def.category,
    ...(def.nativeOnly ? { nativeOnlyProvider: def.nativeOnly.provider } : {}),
    ...(def.requireFeatures ? { requireFeatures: def.requireFeatures } : {}),
    eligible,
    documentedOnly,
    configuredProviders,
    routedProviders: configuredProviders.filter((provider) => eligibleProviders.has(provider)),
  };
}

/** Machine-readable reason codes for an unroutable intent. */
export type IntentRejectReason =
  | "no-tools-for-category"
  | "documented-but-unwired"
  | "required-features-unsatisfied"
  | "not-in-configured-pool"
  | "category-mismatch";

export interface IntentRejection {
  intent: SearchIntent;
  reason: IntentRejectReason;
  /** Capability the caller selected when an intent belongs to another category. */
  capability?: CapabilityName;
  /** Ids of documented-but-unwired tools that would otherwise qualify. */
  documentedOnly: string[];
}

export interface IntentDispatchOptions {
  intent?: SearchIntent;
  providers?: string[];
  requireFeatures?: string[];
  commonOptions?: CommonOptions;
}

/**
 * Thrown when an intent cannot be routed to any eligible wired tool. Raised
 * BEFORE any network call; the CLI renders `rejection` and exits non-zero.
 */
export class IntentRejectionError extends Error {
  /** Error taxonomy category for CLI/status classification. */
  readonly category: "unsupported_capability" | "config";

  constructor(readonly rejection: IntentRejection) {
    const categoryMismatch = rejection.reason === "category-mismatch";
    const requestedCapability = rejection.capability;
    const allowedIntents = requestedCapability
      ? Object.entries(INTENT_DEFS)
          .filter(([, definition]) => definition.category === requestedCapability)
          .map(([intent]) => intent)
          .join(", ")
      : "";
    const documented =
      rejection.documentedOnly.length > 0
        ? ` Registry tools without a wired normalized path: ${rejection.documentedOnly.join(", ")}.`
        : "";
    super(
      categoryMismatch && requestedCapability
        ? `Invalid intent for '${requestedCapability}': '${rejection.intent}' backs the '${INTENT_DEFS[rejection.intent].category}' category. ` +
            `Intents for '${requestedCapability}': ${allowedIntents}.`
        : `Intent '${rejection.intent}' is not routable (${rejection.reason}).${documented}`
    );
    this.name = "IntentRejectionError";
    this.category = categoryMismatch ? "config" : "unsupported_capability";
  }
}

/** Reject an intent that belongs to a different normalized capability. */
export function validateIntentCategory(
  capability: CapabilityName,
  intent: SearchIntent
): void {
  if (INTENT_DEFS[intent].category === capability) return;
  throw new IntentRejectionError({
    intent,
    reason: "category-mismatch",
    capability,
    documentedOnly: [],
  });
}

/**
 * Reject an intent resolution that cannot be executed. Throws
 * IntentRejectionError; returns the resolution unchanged when routable.
 *
 * A resolution is unroutable when no eligible wired tool exists, or
 * when the category is configured but none of the configured providers can
 * back the intent. An unconfigured category (e.g. map/answer/research have no
 * CLI command today) is resolution-only: it rejects only on eligibility
 * grounds, not on the missing pool.
 */
export function rejectIntent(resolution: IntentResolution): IntentResolution {
  const { intent, eligible, documentedOnly, configuredProviders, routedProviders, requireFeatures } =
    resolution;

  if (eligible.length === 0) {
    const reason: IntentRejectReason =
      documentedOnly.length > 0
        ? "documented-but-unwired"
        : requireFeatures && requireFeatures.length > 0
          ? "required-features-unsatisfied"
          : "no-tools-for-category";
    throw new IntentRejectionError({
      intent,
      reason,
      documentedOnly: documentedOnly.map((entry) => entry.id),
    });
  }

  if (configuredProviders.length > 0 && routedProviders.length === 0) {
    throw new IntentRejectionError({
      intent,
      reason: "not-in-configured-pool",
      documentedOnly: documentedOnly.map((entry) => entry.id),
    });
  }

  return resolution;
}

/**
 * Canonicalize intent-derived routing requirements at the execution boundary.
 * CLI callers and direct backend/engine callers therefore get the same pool,
 * feature predicates, and content request behavior.
 */
export function resolveOptionsForIntent<T extends IntentDispatchOptions>(
  capability: CapabilityName,
  config: Config,
  options: T
): T {
  if (!options.intent) return options;

  validateIntentCategory(capability, options.intent);

  const providerOverride = options.providers?.length ? options.providers : undefined;
  const resolution = rejectIntent(resolveIntent(options.intent, config, providerOverride));
  const requireFeatures = [
    ...new Set([...(options.requireFeatures ?? []), ...(resolution.requireFeatures ?? [])]),
  ];

  return {
    ...options,
    ...(resolution.nativeOnlyProvider
      ? { providers: resolution.routedProviders }
      : {}),
    ...(requireFeatures.length > 0 ? { requireFeatures } : {}),
    ...(options.intent === "content-backed-retrieval"
      ? { commonOptions: { ...options.commonOptions, includeContent: true } }
      : {}),
  };
}
