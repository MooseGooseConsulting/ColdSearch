import { homedir } from "node:os";
import { join } from "node:path";
import { keysError } from "./errors.js";

/** How `keys rotate` picks the account the slot should point at. */
export type RotationPolicy = "soonest-reset" | "in-order";

/** Providers `coldsearch keys` knows how to meter or rotate. */
export const KEY_PROVIDERS = ["firecrawl", "tavily", "serper", "exa", "parallel"] as const;
export type KeyProvider = (typeof KEY_PROVIDERS)[number];

/**
 * One provider's slot and pool, read from `[keys.<provider>]`.
 *
 * The slot is the secret every consumer reads. Its value is a same-config
 * reference (`${POOL_MEMBER}`) to one pool member; rotating rewrites that
 * reference and never copies a key.
 */
export interface KeyProviderConfig {
  provider: KeyProvider;
  /** Secret name consumers read, e.g. `FIRECRAWL_API_KEY`. */
  slot: string;
  /** Secret names holding one account key each; order is the preferred use order. */
  pool: string[];
  /** Doppler project holding the slot and the pool. */
  project: string;
  /** Doppler config holding the slot and the pool. */
  config: string;
  policy: RotationPolicy;
  /** An account with this much allowance or less counts as spent. */
  floor: number;
  /** Origin of the provider's usage endpoint; overridden in tests. Undefined uses the provider's own. */
  baseUrl?: string;
}

export interface KeysConfig {
  /** Gateway ledger to read spend from for providers with no balance endpoint. */
  ledgerPath?: string;
  providers: KeyProviderConfig[];
}

/** Doppler secret names: capitals, digits and underscores, not starting with a digit. */
const SECRET_NAME = /^[A-Z_][A-Z0-9_]*$/;
/** Doppler project and config names. Must not start with `-`: they are passed as argv values. */
const DOPPLER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function expandHome(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

function secretName(value: unknown, field: string): string {
  if (typeof value !== "string" || !SECRET_NAME.test(value)) {
    throw keysError("config", `[keys] ${field} must be a secret name (capital letters, digits and underscores)`);
  }
  return value;
}

function dopplerName(value: unknown, field: string, what: string): string {
  if (typeof value !== "string" || !DOPPLER_NAME.test(value)) {
    throw keysError("config", `[keys] ${field} must be the name of the Doppler ${what} holding the slot and the pool`);
  }
  return value;
}

/**
 * Read the `[keys]` table of a parsed config into a validated shape.
 * Throws with a `[keys]`-prefixed message naming the bad field. Secret names
 * only: the table never holds a key value.
 */
export function resolveKeysConfig(raw: unknown): KeysConfig {
  if (raw === undefined || raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw keysError("config", "[keys] section missing: add a [keys.<provider>] block to the config (see docs/components/keys.md)");
  }
  const section = raw as Record<string, unknown>;

  let ledgerPath: string | undefined;
  if (section.ledger !== undefined) {
    if (typeof section.ledger !== "string" || !section.ledger.trim()) {
      throw keysError("config", "[keys] ledger must be the path of a gateway ledger file");
    }
    ledgerPath = expandHome(section.ledger);
  }

  const providers: KeyProviderConfig[] = [];
  for (const [name, value] of Object.entries(section)) {
    if (name === "ledger") continue;
    if (!(KEY_PROVIDERS as readonly string[]).includes(name)) {
      throw keysError("config", `[keys] "${name}" is not a supported provider; supported: ${KEY_PROVIDERS.join(", ")}`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw keysError("config", `[keys] ${name} must be a table`);
    }
    const block = value as Record<string, unknown>;

    const slot = secretName(block.slot, `${name}.slot`);

    if (!Array.isArray(block.pool) || block.pool.length === 0) {
      throw keysError("config", `[keys] ${name}.pool must be a list of at least one secret name`);
    }
    const pool = block.pool.map((entry, index) => secretName(entry, `${name}.pool[${index}]`));
    if (new Set(pool).size !== pool.length) {
      throw keysError("config", `[keys] ${name}.pool lists the same secret name twice`);
    }
    if (pool.includes(slot)) {
      throw keysError("config", `[keys] ${name}.pool must not contain the slot (${slot}); the slot refers to a pool member`);
    }

    const policy = block.policy ?? "soonest-reset";
    if (policy !== "soonest-reset" && policy !== "in-order") {
      throw keysError("config", `[keys] ${name}.policy must be "soonest-reset" or "in-order"`);
    }

    const floor = block.floor ?? 0;
    if (typeof floor !== "number" || !Number.isFinite(floor) || floor < 0) {
      throw keysError("config", `[keys] ${name}.floor must be a number, zero or more`);
    }

    let baseUrl: string | undefined;
    if (block.base_url !== undefined) {
      try {
        if (typeof block.base_url !== "string") throw new Error("not a string");
        baseUrl = new URL(block.base_url).toString().replace(/\/+$/, "");
      } catch {
        throw keysError("config", `[keys] ${name}.base_url is not a valid URL`);
      }
    }

    providers.push({
      provider: name as KeyProvider,
      slot,
      pool,
      project: dopplerName(block.project, `${name}.project`, "project"),
      config: dopplerName(block.config, `${name}.config`, "config"),
      policy,
      floor,
      baseUrl,
    });
  }
  if (providers.length === 0) {
    throw keysError("config", "[keys] no providers configured: add at least one [keys.<provider>] block");
  }

  return { ledgerPath, providers };
}
