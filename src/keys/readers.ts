import { APP_USER_AGENT } from "../app.js";
import { redact } from "../gateway/ledger.js";
import type { KeyProvider } from "./config.js";

/** What one key's account has left, as the provider reports it. */
export interface AllowanceReading {
  remaining: number;
  /** Size of the plan's allowance for the period; null when the provider reports only a balance. */
  limit: number | null;
  unit: "credits";
  /** When the current allowance lapses (ISO 8601), when the provider says. */
  period_end?: string;
  /**
   * Text that is the same for every key of one account and differs between
   * accounts, when the response carries such proof. Two pool keys with equal
   * values are one allowance, not two.
   */
  account?: string;
}

/** The allowance could not be read; `unknown` says why, in words safe to print. */
export interface AllowanceUnknown {
  unknown: string;
}

export type Allowance = AllowanceReading | AllowanceUnknown;

export function isUnknown(allowance: Allowance): allowance is AllowanceUnknown {
  return "unknown" in allowance;
}

/** Origin of each provider's usage endpoint; absent for providers that have none for an ordinary key. */
export const USAGE_BASE_URLS: Partial<Record<KeyProvider, string>> = {
  firecrawl: "https://api.firecrawl.dev",
  tavily: "https://api.tavily.com",
  serper: "https://google.serper.dev",
};

const TIMEOUT_MS = 15_000;

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function field(value: unknown, name: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[name] : undefined;
}

/**
 * GET a usage endpoint and return its JSON body, or the reason it could not
 * be had. The key travels in a request header only, and the reason is built
 * from the status code or the transport error with the key redacted; the
 * response body is never quoted.
 */
async function getJson(url: string, headers: Record<string, string>, key: string): Promise<unknown | AllowanceUnknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": APP_USER_AGENT, ...headers },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const err = error as Error & { cause?: { code?: string } };
    const detail = err.name === "TimeoutError" ? "timed out" : err.cause?.code ?? err.message;
    return { unknown: redact(`usage endpoint unreachable (${detail})`, [key]) };
  }
  if (response.status === 401 || response.status === 403) {
    return { unknown: `key rejected by the usage endpoint (HTTP ${response.status})` };
  }
  if (response.status === 429) return { unknown: "usage endpoint rate limited (HTTP 429)" };
  if (!response.ok) return { unknown: `usage endpoint returned HTTP ${response.status}` };
  try {
    return await response.json();
  } catch {
    return { unknown: "usage endpoint did not return JSON" };
  }
}

function isReason(body: unknown): body is AllowanceUnknown {
  return !!body && typeof body === "object" && typeof (body as AllowanceUnknown).unknown === "string";
}

/**
 * Firecrawl: `GET /v2/team/credit-usage`. `planCredits` excludes coupon and
 * pay-as-you-go credits, so `remaining` can exceed `limit`. Keys of one team
 * report the same billing period and plan, which is the account proof.
 */
async function readFirecrawl(key: string, baseUrl: string): Promise<Allowance> {
  const body = await getJson(`${baseUrl}/v2/team/credit-usage`, { Authorization: `Bearer ${key}` }, key);
  if (isReason(body)) return body;
  const data = field(body, "data");
  const remaining = num(field(data, "remainingCredits"));
  if (remaining === undefined) return { unknown: "usage response has no data.remainingCredits" };
  const limit = num(field(data, "planCredits")) ?? null;
  const periodStart = str(field(data, "billingPeriodStart"));
  const periodEnd = str(field(data, "billingPeriodEnd"));
  return {
    remaining,
    limit,
    unit: "credits",
    period_end: periodEnd,
    account: periodStart ? `${periodStart}|${periodEnd ?? ""}|${limit ?? ""}` : undefined,
  };
}

/** Tavily: `GET /usage`. The response carries no period dates. */
async function readTavily(key: string, baseUrl: string): Promise<Allowance> {
  const body = await getJson(`${baseUrl}/usage`, { Authorization: `Bearer ${key}` }, key);
  if (isReason(body)) return body;
  const account = field(body, "account");
  const limit = num(field(account, "plan_limit"));
  const usage = num(field(account, "plan_usage"));
  if (limit === undefined || usage === undefined) {
    return { unknown: "usage response has no account.plan_limit and account.plan_usage" };
  }
  return { remaining: limit - usage, limit, unit: "credits" };
}

/**
 * Serper: `GET /account`. A prepaid balance with no plan size and no period.
 * Serper publishes no reference documentation; this path and its top-level
 * numeric `balance` are known from third-party sources only and unconfirmed
 * against a live account. Any other shape is returned as unknown.
 */
async function readSerper(key: string, baseUrl: string): Promise<Allowance> {
  const body = await getJson(`${baseUrl}/account`, { "X-API-KEY": key }, key);
  if (isReason(body)) return body;
  const balance = num(field(body, "balance"));
  if (balance === undefined) return { unknown: "account response has no balance" };
  return { remaining: balance, limit: null, unit: "credits" };
}

const READERS: Partial<Record<KeyProvider, (key: string, baseUrl: string) => Promise<Allowance>>> = {
  firecrawl: readFirecrawl,
  tavily: readTavily,
  serper: readSerper,
};

/** True when the provider has a usage endpoint an ordinary key can call. */
export function hasBalanceEndpoint(provider: KeyProvider): boolean {
  return READERS[provider] !== undefined;
}

/** Why a provider without a usage endpoint reports no allowance. */
export function noEndpointReason(provider: KeyProvider): string {
  return `${provider} has no balance endpoint for an ordinary key`;
}

/**
 * Ask a provider how much allowance the account behind `key` has left.
 *
 * Never throws: a failure is returned as `{ unknown }` with a reason that
 * holds no key material. For a provider with no usage endpoint (exa,
 * parallel) it returns `{ unknown }` without making a request; callers that
 * know this need not resolve the key at all.
 */
export async function readAllowance(provider: KeyProvider, key: string, baseUrl?: string): Promise<Allowance> {
  const reader = READERS[provider];
  const origin = baseUrl ?? USAGE_BASE_URLS[provider];
  if (!reader || !origin) return { unknown: noEndpointReason(provider) };
  return reader(key, origin.replace(/\/+$/, ""));
}
