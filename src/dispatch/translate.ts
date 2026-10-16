import { wiredToolForProviderCategory } from "../registry/tool-profiles.js";
import type {
  CapabilityCategory,
  CommonOptions,
  CommonViewMapping,
} from "../types.js";

/**
 * Common-options translation (issue #79, PR-D).
 *
 * An intent picks the tool. This translator forwards only common options with
 * a declared 1:1 scalar parameter mapping. Expression mappings stay off the
 * request and are handled by the adapter or reported as unsupported.
 */

/** A provider-native parameter name is a plain scalar key (snake/camel). */
const SCALAR_PARAM = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface TranslationResult {
  /** Provider-native parameters to merge into the adapter's providerOptions. */
  params: Record<string, unknown>;
  /** One-line debug notes for options that were not forwarded. */
  skipped: string[];
}

const FILTER_OPTIONS = ["includeDomains", "excludeDomains", "timeRange"] as const;

function skippedProviderReason(issues: string[]): string {
  return `Not called because this tool cannot honor the requested filters: ${issues.join("; ")}`;
}

/** A provider cannot be selected when it would have to ignore a requested filter. */
export class UnsupportedCommonOptionsError extends Error {
  readonly category = "unsupported_capability" as const;
  readonly skippedProviders: Record<string, string>;

  constructor(capability: CapabilityCategory, providerIssues: Record<string, string[]>) {
    const details = Object.entries(providerIssues)
      .map(([provider, issues]) => `${provider}: ${issues.join(", ")}`)
      .join("; ");
    super(
      `No configured ${capability} provider can honor the requested common filters (${details})`
    );
    this.name = "UnsupportedCommonOptionsError";
    this.skippedProviders = Object.fromEntries(
      Object.entries(providerIssues).map(([provider, issues]) => [
        provider,
        skippedProviderReason(issues),
      ])
    );
  }
}

/** Explain why a provider view cannot honor the requested domain/date filters. */
export function unsupportedCommonFilterOptions(
  view: CommonViewMapping | undefined,
  commonOptions: CommonOptions | undefined
): string[] {
  if (!commonOptions) return [];
  const unsupported = new Set(view?.unsupportedCommonOptions ?? []);
  const issues: string[] = [];

  for (const key of FILTER_OPTIONS) {
    const value = commonOptions[key];
    const requested = key === "timeRange"
      ? typeof value === "string" && value.trim().length > 0
      : Array.isArray(value) && value.length > 0;
    if (!requested) continue;

    if (unsupported.has(key)) {
      issues.push(`${key} is unsupported`);
      continue;
    }
    if (!view?.mapsCommonOptions[key]) {
      issues.push(`${key} has no native mapping`);
      continue;
    }

    const valueMappings = view.commonOptionValueMappings?.[key];
    if (
      valueMappings &&
      !Object.hasOwn(valueMappings, String(value))
    ) {
      issues.push(`${key} value '${String(value)}' is unsupported`);
    }
  }

  return issues;
}

/**
 * Remove providers whose wired tool view cannot honor requested search
 * filters. Exclusions are routing explanations, not failed provider calls.
 */
export function filterProvidersByCommonOptions(
  capability: CapabilityCategory,
  providers: string[],
  commonOptions: CommonOptions | undefined
): {
  providers: string[];
  skippedProviders: Record<string, string>;
  issuesByProvider: Record<string, string[]>;
} {
  const skippedProviders: Record<string, string> = {};
  const issuesByProvider: Record<string, string[]> = {};
  const eligible = providers.filter((provider) => {
    const profile = wiredToolForProviderCategory(provider, capability);
    const view = profile?.commonViews.find((entry) => entry.category === capability);
    const issues = unsupportedCommonFilterOptions(view, commonOptions);
    if (issues.length === 0) return true;
    issuesByProvider[provider] = issues;
    skippedProviders[provider] = skippedProviderReason(issues);
    return false;
  });

  return { providers: eligible, skippedProviders, issuesByProvider };
}

/**
 * Forward supported scalar mappings under the view's provider-native names.
 * Expression mappings, such as includeContent -> "include_raw_content or
 * advanced chunks", are skipped with a debug note.
 */
export function translateCommonOptions(
  view: CommonViewMapping | undefined,
  commonOptions: CommonOptions | Record<string, unknown> | undefined
): TranslationResult {
  const params: Record<string, unknown> = {};
  const skipped: string[] = [];
  if (!commonOptions) return { params, skipped };

  for (const [key, value] of Object.entries(commonOptions)) {
    if (value === undefined || value === null) continue;
    if (![
      "limit",
      "includeDomains",
      "excludeDomains",
      "timeRange",
      "includeContent",
    ].includes(key)) {
      skipped.push(`common option '${key}' is not forwarded by the scalar translator`);
      continue;
    }
    const target = view?.mapsCommonOptions[key];
    if (!target) {
      skipped.push(`common option '${key}' has no declared mapping for this view; not forwarded`);
      continue;
    }
    if (!SCALAR_PARAM.test(target)) {
      skipped.push(
        `mapping '${key}' -> '${target}' is expression-style (not a 1:1 scalar); not forwarded`
      );
      continue;
    }
    const valueMappings = view.commonOptionValueMappings?.[key];
    if (valueMappings) {
      const mappedValue = valueMappings[String(value)];
      if (mappedValue === undefined) {
        skipped.push(`common option '${key}' value '${String(value)}' is unsupported for this view`);
        continue;
      }
      params[target] = mappedValue;
      continue;
    }
    params[target] = value;
  }
  return { params, skipped };
}

export interface ResolvedProviderOptions {
  /** Merged providerOptions for the adapter call (undefined when empty). */
  providerOptions: Record<string, unknown> | undefined;
  /** Debug notes for skipped translations. */
  notes: string[];
}

/**
 * Resolve the providerOptions object for one capability-path adapter call:
 * the provider's wired tool view for the category translates the invocation's
 * common options, and the result is merged OVER the config-level
 * [providers.X.options] (invocation wins). The caller's config object is never
 * mutated.
 */
export function resolveTranslatedProviderOptions(
  provider: string,
  category: CapabilityCategory,
  commonOptions: CommonOptions | undefined,
  configOptions: Record<string, unknown> | undefined
): ResolvedProviderOptions {
  const profile = wiredToolForProviderCategory(provider, category);
  const view = profile?.commonViews.find((entry) => entry.category === category);
  const { params, skipped } = translateCommonOptions(view, commonOptions);

  const merged = { ...(configOptions ?? {}), ...params };
  const notes = skipped.map((note) => `${provider}.${profile?.tool ?? "?"}: ${note}`);
  return {
    providerOptions: Object.keys(merged).length > 0 ? merged : undefined,
    notes,
  };
}

/**
 * Emit translation debug notes on stderr, gated behind COLDSEARCH_DEBUG so
 * routine output stays clean.
 */
export function emitTranslationNotes(notes: string[]): void {
  if (!process.env.COLDSEARCH_DEBUG) return;
  for (const note of notes) {
    console.error(`Debug: ${note}`);
  }
}
