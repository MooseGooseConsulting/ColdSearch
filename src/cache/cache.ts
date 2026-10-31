import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * On-disk shape of a single cache entry.
 *
 * `origin_execution_id` is PR 2 provenance: the history execution that
 * produced this entry, so a replay can link back to its origin. Entries
 * written before provenance existed simply lack the field — they are treated
 * as "provenance unknown", not migrated.
 */
interface CacheEntry<T = unknown> {
  key: string;
  payload: T;
  created_at: number;
  ttl_seconds: number;
  origin_execution_id?: string;
}

/** Provenance metadata returned alongside a cache hit. */
export interface CacheEntryMeta {
  created_at: number;
  ttl_seconds: number;
  /** null for entries written before provenance existed ("unknown"). */
  origin_execution_id: string | null;
}

export interface CacheStats {
  path: string;
  total_entries: number;
  total_bytes: number;
  expired_entries: number;
  capabilities: Record<string, { entries: number; bytes: number }>;
  oldest_created_at: string | null;
  newest_created_at: string | null;
  /**
   * Owned entries (regular files) that could not be read or whose JSON /
   * timing metadata is invalid. They are still counted in the totals above
   * but contribute no timing metadata.
   */
  corrupt_entries: number;
  /**
   * Paths that are not cache-owned (linked capability directories, linked or
   * non-regular entries) or could not be enumerated. They are never read or
   * counted. Non-secret `<capability>[/<file>]: <reason>` strings.
   */
  skipped: string[];
}

export interface CacheClearResult {
  removed: number;
  errors: string[];
  /** Non-owned paths (links, non-regular entries) left untouched. */
  skipped: string[];
}

/** Largest magnitude a JS `Date` can represent (ECMA-262 time value range). */
const MAX_DATE_MS = 8.64e15;

/** The capability directories the cache owns under its root. */
const CACHE_CAPABILITIES = ["search", "extract", "tool"] as const;

/**
 * Validate the timing metadata of a parsed entry. `created_at` must be a finite
 * epoch-ms inside the `Date` range so it can be formatted; `ttl_seconds` must be
 * finite and non-negative (zero is valid: it simply never satisfies a fresh
 * window). Anything else is corruption, not data to replay.
 */
function hasValidTiming(entry: unknown): entry is { created_at: number; ttl_seconds: number } {
  if (!entry || typeof entry !== "object") return false;
  const { created_at, ttl_seconds } = entry as Record<string, unknown>;
  return (
    typeof created_at === "number" &&
    Number.isFinite(created_at) &&
    Math.abs(created_at) <= MAX_DATE_MS &&
    typeof ttl_seconds === "number" &&
    Number.isFinite(ttl_seconds) &&
    ttl_seconds >= 0
  );
}

/**
 * True only for a real directory. `lstat` does not follow links, so POSIX
 * symlinks and Windows junctions/symlinks are rejected here.
 */
function isOwnedDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** True only for a real (non-linked) regular file. */
function isOwnedFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * A cache write may publish over a path that is absent (ENOENT) or already an
 * owned regular file. Linked or otherwise non-regular targets, and targets
 * whose state cannot be determined (any other lstat error), are not written.
 */
function isWritableTarget(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultCachePath(): string {
  return join(homedir(), ".config", "coldsearch", "cache");
}

function expandHome(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return join(homedir(), p.slice(2));
  }
  return p;
}

/**
 * File-based read-through cache.
 *
 * One JSON file per entry at `<path>/<capability>/<key>.json`. Reads are lazy:
 * expiry is checked on `get`/`getEntry` (no background sweep). Request-path
 * disk operations (`get`/`set`) are best-effort — a cache failure must never
 * break a request, mirroring the `UsageLogger.write` try/catch contract in
 * `src/logging/usage.ts`. Maintenance operations (`stats`/`clear`) report
 * problems to the caller instead of hiding them.
 *
 * Writes are atomic (tmp file + rename) and permissions are restrictive
 * (0o700 directories, 0o600 files) where the platform supports them.
 *
 * Ownership: the configured root is followed as given (it may itself be a
 * symlink the user chose). Everything beneath it must be a real directory
 * (capability) containing real `.json` files (entries) — checked with `lstat`.
 * Linked capability directories and linked/non-regular entries are never read,
 * written, counted, or deleted, so a link cannot redirect the cache at data
 * outside its root. This is a check-then-use guard, not isolation against a
 * path being swapped concurrently.
 */
export class CacheStore {
  private readonly enabled: boolean;
  private readonly path: string;

  constructor(options?: { enabled?: boolean; path?: string }) {
    this.enabled = options?.enabled !== false;
    // Guard against a non-string [cache].path from unvalidated TOML.
    const rawPath = typeof options?.path === "string" ? options.path : undefined;
    this.path = expandHome(rawPath || defaultCachePath());
  }

  getPath(): string {
    return this.path;
  }

  private entryPath(capability: string, key: string): string {
    return join(this.path, capability, `${key}.json`);
  }

  /**
   * Return the stored payload and provenance for a key, or null on
   * miss / corruption. Never throws.
   *
   * Expiry is deliberately NOT enforced here: freshness is the caller's
   * decision (isFresh against the invocation's effective TTL), so a
   * per-invocation `--freshness` override can also WIDEN the accepted
   * window. Deleting an "expired" entry at read time would persist the
   * stored TTL's policy into later invocations and make longer overrides
   * impossible. Expired entries are reported by `stats()` and removed by
   * `clear()`.
   */
  getEntry<T = unknown>(
    capability: string,
    key: string,
    isValid?: (payload: unknown) => payload is T
  ): { payload: T; meta: CacheEntryMeta } | null {
    if (!this.enabled) return null;

    const file = this.entryPath(capability, key);
    try {
      if (!isOwnedDir(join(this.path, capability)) || !isOwnedFile(file)) return null;

      const raw = readFileSync(file, "utf8");
      const entry = JSON.parse(raw) as CacheEntry<T>;

      if (!hasValidTiming(entry) || (isValid && !isValid(entry.payload))) {
        return null;
      }

      return {
        payload: entry.payload,
        meta: {
          created_at: entry.created_at,
          ttl_seconds: entry.ttl_seconds,
          origin_execution_id:
            typeof entry.origin_execution_id === "string"
              ? entry.origin_execution_id
              : null,
        },
      };
    } catch {
      // Missing / corrupt / unreadable — treat as a miss.
      return null;
    }
  }

  /**
   * Return the stored payload for a key, or null on miss / corruption.
   * Never throws. Freshness is the caller's decision — see getEntry.
   */
  get<T = unknown>(capability: string, key: string): T | null {
    return this.getEntry<T>(capability, key)?.payload ?? null;
  }

  /**
   * Best-effort atomic write of a cache entry. No-op when disabled; swallows
   * all errors so a cache write can never break a request.
   *
   * `provenance.originExecutionId` links the entry to the history execution
   * that produced it, so a later replay can record its origin.
   */
  set<T = unknown>(
    capability: string,
    key: string,
    payload: T,
    ttlSeconds: number,
    provenance?: { originExecutionId?: string }
  ): void {
    if (!this.enabled) return;

    const target = this.entryPath(capability, key);
    const tmp = `${target}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;

    try {
      const dir = join(this.path, capability);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      // A linked capability directory would redirect the write outside the
      // cache root; treat it like any other write failure (best-effort skip).
      if (!isOwnedDir(dir)) return;
      // rename() would replace an existing symlink (live or dangling) or
      // other non-regular entry with the new file. Inspect the target itself
      // (lstat does not follow links; existsSync reports a dangling link as
      // absent): only an absent target or an owned regular file may be written.
      if (!isWritableTarget(target)) return;

      const entry: CacheEntry<T> = {
        key,
        payload,
        created_at: Date.now(),
        ttl_seconds: ttlSeconds,
        ...(provenance?.originExecutionId
          ? { origin_execution_id: provenance.originExecutionId }
          : {}),
      };

      // Atomic publish: write a sibling tmp file, then rename over the target.
      writeFileSync(tmp, JSON.stringify(entry), { encoding: "utf8", mode: 0o600 });
      renameSync(tmp, target);
      try {
        chmodSync(target, 0o600);
      } catch {
        // Restrictive permissions where supported; tolerate platforms where
        // chmod is a no-op or unsupported.
      }
    } catch {
      // Best-effort: cache write failures must never break core operations.
      try {
        unlinkSync(tmp);
      } catch {
        // No tmp file left behind to clean up.
      }
    }
  }

  /**
   * Enumerate the owned capability directories under the root. Only the known
   * capability names (`search`, `extract`, `tool`) are considered, so unrelated
   * children of the root are never read or cleared. A linked capability
   * directory, or one whose state cannot be inspected, is reported in
   * `skipped` rather than followed. Returns null when the root does not exist.
   */
  private ownedCapabilities(skipped: string[]): string[] | null {
    if (!existsSync(this.path)) return null;

    const capabilities: string[] = [];
    // readdirSync still throws for a root that is not a directory, so a
    // misconfigured path fails visibly instead of reporting an empty cache.
    for (const capability of readdirSync(this.path)) {
      if (!(CACHE_CAPABILITIES as readonly string[]).includes(capability)) continue;
      const capDir = join(this.path, capability);
      let info;
      try {
        info = lstatSync(capDir);
      } catch (error) {
        skipped.push(`${capability}: could not inspect: ${describe(error)}`);
        continue;
      }
      if (info.isSymbolicLink()) {
        skipped.push(`${capability}: linked directory (symlink/junction) not followed`);
      } else if (info.isDirectory()) {
        capabilities.push(capability);
      }
    }
    return capabilities;
  }

  /**
   * List the `.json` entries of one owned capability directory, splitting
   * owned regular files (`entries`) from linked / non-regular ones (`skipped`,
   * never touched). `error` is set when the directory cannot be enumerated.
   */
  private ownedEntries(capability: string): {
    entries: { file: string; filePath: string }[];
    skipped: string[];
    error?: string;
  } {
    const capDir = join(this.path, capability);
    const found = { entries: [] as { file: string; filePath: string }[], skipped: [] as string[] };

    let names: string[];
    try {
      names = readdirSync(capDir);
    } catch (error) {
      return { ...found, error: describe(error) };
    }

    for (const file of names) {
      if (!file.endsWith(".json")) continue;
      const filePath = join(capDir, file);
      if (isOwnedFile(filePath)) {
        found.entries.push({ file, filePath });
      } else {
        found.skipped.push(`${capability}/${file}: linked or non-regular entry not followed`);
      }
    }
    return found;
  }

  /**
   * Describe replay-cache storage for `cache stats`. This is replay-cache
   * state only — it says nothing about research-history counts. Only owned
   * entries are read; see the class comment for what that means.
   */
  stats(): CacheStats {
    const stats: CacheStats = {
      path: this.path,
      total_entries: 0,
      total_bytes: 0,
      expired_entries: 0,
      capabilities: {},
      oldest_created_at: null,
      newest_created_at: null,
      corrupt_entries: 0,
      skipped: [],
    };

    const capabilities = this.ownedCapabilities(stats.skipped);
    if (!capabilities) return stats;

    let oldest = Infinity;
    let newest = -Infinity;

    for (const capability of capabilities) {
      const listing = this.ownedEntries(capability);
      stats.skipped.push(...listing.skipped);
      if (listing.error !== undefined) {
        stats.skipped.push(`${capability}: could not enumerate: ${listing.error}`);
        continue;
      }

      const perCap = { entries: 0, bytes: 0 };
      for (const { file, filePath } of listing.entries) {
        let size: number;
        try {
          size = lstatSync(filePath).size;
        } catch {
          stats.skipped.push(`${capability}/${file}: disappeared before it could be read`);
          continue;
        }
        // An owned file counts as stored material even when it is corrupt or
        // unreadable (entries and bytes), but contributes no timing metadata
        // and is reported in `corrupt_entries`.
        perCap.entries += 1;
        perCap.bytes += size;

        try {
          const entry: unknown = JSON.parse(readFileSync(filePath, "utf8"));
          if (!hasValidTiming(entry)) {
            stats.corrupt_entries += 1;
            continue;
          }
          if (entry.created_at + entry.ttl_seconds * 1000 < Date.now()) {
            stats.expired_entries += 1;
          }
          oldest = Math.min(oldest, entry.created_at);
          newest = Math.max(newest, entry.created_at);
        } catch {
          stats.corrupt_entries += 1;
        }
      }

      if (perCap.entries > 0) {
        stats.capabilities[capability] = perCap;
        stats.total_entries += perCap.entries;
        stats.total_bytes += perCap.bytes;
      }
    }

    stats.oldest_created_at = oldest === Infinity ? null : new Date(oldest).toISOString();
    stats.newest_created_at = newest === -Infinity ? null : new Date(newest).toISOString();
    return stats;
  }

  /**
   * Delete all owned replay-cache entries. History records are never touched
   * (they live outside this directory). Linked capability directories and
   * linked/non-regular entries are left in place and listed in `skipped`;
   * `removed` only counts files this call actually unlinked. Removal failures
   * are returned as non-secret `errors`.
   */
  clear(): CacheClearResult {
    const result: CacheClearResult = { removed: 0, errors: [], skipped: [] };

    const capabilities = this.ownedCapabilities(result.skipped);
    if (!capabilities) return result;

    for (const capability of capabilities) {
      // A directory that cannot be enumerated must not abort the whole clear
      // after other directories were already partially deleted: report it as a
      // non-secret error and continue with the remaining capability
      // directories.
      const listing = this.ownedEntries(capability);
      result.skipped.push(...listing.skipped);
      if (listing.error !== undefined) {
        result.errors.push(`could not enumerate ${capability}/: ${listing.error}`);
        continue;
      }

      for (const { file, filePath } of listing.entries) {
        try {
          unlinkSync(filePath);
          result.removed += 1;
        } catch (error) {
          result.errors.push(`could not remove ${capability}/${file}: ${describe(error)}`);
        }
      }
    }

    return result;
  }
}
