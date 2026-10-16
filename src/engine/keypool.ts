import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { KeyPool } from "../types.js";
import { safeKeyRef } from "../logging/usage.js";

const execFileAsync = promisify(execFile);

export interface KeyResult {
  value: string;
  ref: string;
}

/**
 * In-process cache for a resolved Doppler secret.
 * Only the resolved value lives here, in memory, for the life of the process —
 * it is never logged or persisted. `expiresAt` bounds staleness so a rotated
 * secret eventually takes effect (see `resolveSecretCacheTtlMs()` /
 * COLDSEARCH_SECRET_CACHE_TTL env var).
 */
interface CachedSecret {
  value: string;
  expiresAt: number;
}

/**
 * TTL (ms) for the in-process Doppler secret cache.
 *
 * Caching avoids re-invoking the Doppler CLI for every request during provider
 * fanout. The tradeoff is freshness: a rotated secret is not picked up until the
 * cached entry expires.
 *
 * Override with COLDSEARCH_SECRET_CACHE_TTL (seconds):
 *   - unset / invalid -> default 300s (5 minutes)
 *   - 0               -> caching disabled (every resolution hits the CLI)
 */
function resolveSecretCacheTtlMs(): number {
  const raw = process.env.COLDSEARCH_SECRET_CACHE_TTL;
  if (raw === undefined || raw.trim() === "") {
    return 5 * 60 * 1000;
  }
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return 5 * 60 * 1000;
  }
  return Math.floor(seconds * 1000);
}

/**
 * Per-provider default Doppler secret names used when a key pool has no
 * explicit `keys` and no `defaultSecretName`. Shared with `config doctor` so
 * diagnostics and runtime resolution never drift.
 */
export const PROVIDER_DEFAULT_DOPPLER_SECRETS: Record<string, string> = {
  tavily: "TAVILY_API_KEY",
  exa: "EXA_API_KEY",
  firecrawl: "FIRECRAWL_API_KEY",
  brave: "BRAVE_API_KEY",
  serper: "SERPER_API_KEY",
};

export class KeyPoolManager {
  private pools: Map<string, KeyPool> = new Map();
  private indices: Map<string, number> = new Map();
  /** In-memory only; holds resolved secret values keyed by Doppler secret name. */
  private secretCache: Map<string, CachedSecret> = new Map();
  /**
   * Pending Doppler CLI promises keyed by secret name.
   * When caching is enabled and a lookup is already in flight, concurrent
   * callers share the same promise rather than spawning N doppler processes.
   * Cleared in `finally` so errors don't permanently block future lookups.
   */
  private secretLookups: Map<string, Promise<string>> = new Map();

  register(provider: string, pool: KeyPool): void {
    this.pools.set(provider, pool);
    this.indices.set(provider, 0);
  }

  async getNextKey(provider: string): Promise<string> {
    const result = await this.getNextKeyWithRef(provider);
    return result.value;
  }

  async getNextKeyWithRef(provider: string): Promise<KeyResult> {
    const pool = this.pools.get(provider);
    if (!pool) {
      throw new Error(`No key pool registered for provider: ${provider}`);
    }

    const refs = this.getEffectiveKeyRefs(provider, pool);
    if (!refs.length) {
      throw new Error(`Key pool for ${provider} is empty and no default secret name is available`);
    }

    const strategy = pool.strategy || "round-robin";
    let keyIndex: number;

    if (strategy === "random") {
      keyIndex = Math.floor(Math.random() * refs.length);
    } else {
      const currentIndex = this.indices.get(provider) || 0;
      keyIndex = currentIndex % refs.length;
      const nextIndex = (currentIndex + 1) % refs.length;
      this.indices.set(provider, nextIndex);
    }

    const keyRef = refs[keyIndex];
    const value = await this.resolveKeyRef(keyRef);
    return { value, ref: safeKeyRef(keyRef, provider) };
  }

  private getEffectiveKeyRefs(provider: string, pool: KeyPool): string[] {
    if (Array.isArray(pool.keys) && pool.keys.length > 0) {
      return pool.keys;
    }

    if (typeof pool.defaultSecretName === "string") {
      const trimmed = pool.defaultSecretName.trim();
      if (trimmed.length === 0) return [];
      return [`doppler:${trimmed}`];
    }

    const providerDefault = PROVIDER_DEFAULT_DOPPLER_SECRETS[provider];
    if (providerDefault) {
      return [`doppler:${providerDefault}`];
    }

    return [];
  }

  private async resolveKeyRef(keyRef: string): Promise<string> {
    if (keyRef.startsWith("env:")) {
      const varName = keyRef.slice(4);
      const value = process.env[varName];
      if (!value) {
        throw new Error(`Environment variable ${varName} is not set`);
      }
      return value;
    }

    if (keyRef.startsWith("bws:")) {
      throw new Error(
        "Bitwarden Secrets Manager (bws:) support has been removed. " +
        "Replace bws: references in config with doppler: or env: — see docs/BWS_INTEGRATION.md."
      );
    }

    if (keyRef.startsWith("doppler:")) {
      const secretName = keyRef.slice(8).trim();
      if (!secretName) {
        throw new Error("Invalid Doppler secret reference: missing secret name");
      }
      return this.resolveDopplerSecret(secretName);
    }

    return keyRef;
  }

  private resolveDopplerSecret(secretName: string): Promise<string> {
    const ttlMs = resolveSecretCacheTtlMs();

    if (ttlMs > 0) {
      // Return a warm cache hit immediately.
      const cached = this.secretCache.get(secretName);
      if (cached) {
        if (cached.expiresAt > Date.now()) {
          return Promise.resolve(cached.value);
        }
        // Expired — evict so the stale value doesn't linger past its TTL.
        this.secretCache.delete(secretName);
      }

      // Coalesce concurrent lookups: if a CLI call for this secret is already
      // in flight, share it so N fanout callers spawn only one doppler process.
      const inflight = this.secretLookups.get(secretName);
      if (inflight) {
        return inflight;
      }
    }

    // No warm cache hit and no in-flight lookup (or caching is disabled).
    const promise = this._dopplerFetch(secretName, ttlMs);

    if (ttlMs > 0) {
      this.secretLookups.set(secretName, promise);
      // Clear on either outcome without leaving a rejecting `finally()` chain
      // unobserved when the Doppler lookup itself fails.
      void promise.then(
        () => this.secretLookups.delete(secretName),
        () => this.secretLookups.delete(secretName)
      );
    }

    return promise;
  }

  private async _dopplerFetch(secretName: string, ttlMs: number): Promise<string> {
    let value: string;
    try {
      // No-shell guarantee: execFile (shell:false by default) passes the secret
      // name as a literal argv entry — it is never interpolated into a shell
      // command, so it cannot be used for command injection.
      const { stdout } = await execFileAsync(
        "doppler",
        ["secrets", "get", secretName, "--plain"],
        {
          encoding: "utf8",
          timeout: 10000,
        }
      );
      value = stdout.trim();
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        throw new Error("Doppler CLI not found on PATH. Install it from https://docs.doppler.com/docs/cli");
      }
      throw new Error(
        `Failed to resolve Doppler secret "${secretName}". Ensure Doppler is authenticated for this process.`
      );
    }

    if (!value) {
      throw new Error(`Doppler secret "${secretName}" resolved to empty value`);
    }

    if (ttlMs > 0) {
      this.secretCache.set(secretName, { value, expiresAt: Date.now() + ttlMs });
    }

    return value;
  }

  /**
   * Resolve every configured credential value, deduplicated, for persistence
   * redaction. Mirrors how a real invocation resolves keys (env:/doppler:/
   * literal refs), so anything a provider response could echo back is known.
   * Best-effort: an unresolvable ref (missing env var, unauthenticated
   * Doppler) has no value to scrub and is skipped. In-memory only.
   */
  async resolveAllSecrets(): Promise<string[]> {
    const secrets: string[] = [];
    const seen = new Set<string>();
    for (const [provider, pool] of this.pools) {
      for (const ref of this.getEffectiveKeyRefs(provider, pool)) {
        try {
          const value = await this.resolveKeyRef(ref);
          if (value && !seen.has(value)) {
            seen.add(value);
            secrets.push(value);
          }
        } catch {
          // No value to scrub from an unresolvable ref; keep going.
        }
      }
    }
    return secrets;
  }

  getProviders(): string[] {
    return Array.from(this.pools.keys());
  }

  hasKeys(provider: string): boolean {
    const pool = this.pools.get(provider);
    return !!pool && this.getEffectiveKeyRefs(provider, pool).length > 0;
  }

  async getNextKeyOrEmpty(provider: string): Promise<string> {
    if (!this.hasKeys(provider)) {
      return "";
    }
    return this.getNextKey(provider);
  }

  async getNextKeyWithRefOrEmpty(provider: string): Promise<KeyResult> {
    if (!this.hasKeys(provider)) {
      return { value: "", ref: `${provider}:keyless` };
    }
    return this.getNextKeyWithRef(provider);
  }
}

export function createKeyPoolManager(): KeyPoolManager {
  return new KeyPoolManager();
}

export const keyPoolManager = new KeyPoolManager();
