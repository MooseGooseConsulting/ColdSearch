import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
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
  /** Separate sanitized history copy; never used as the replay payload. */
  history_snapshot?: unknown;
}

/** Provenance metadata returned alongside a cache hit. */
export interface CacheEntryMeta {
  created_at: number;
  ttl_seconds: number;
  /** null for entries written before provenance existed ("unknown"). */
  origin_execution_id: string | null;
  /** Optional sanitized history copy; legacy entries have no snapshot. */
  history_snapshot?: unknown;
}

export interface CacheStats {
  path: string;
  total_entries: number;
  total_bytes: number;
  expired_entries: number;
  capabilities: Record<string, { entries: number; bytes: number }>;
  oldest_created_at: string | null;
  newest_created_at: string | null;
}

export interface CacheClearResult {
  removed: number;
  errors: string[];
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
      if (!existsSync(file)) return null;

      const raw = readFileSync(file, "utf8");
      const entry = JSON.parse(raw) as CacheEntry<T>;

      if (
        !entry ||
        typeof entry.created_at !== "number" ||
        typeof entry.ttl_seconds !== "number" ||
        (isValid && !isValid(entry.payload))
      ) {
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
          ...(Object.prototype.hasOwnProperty.call(entry, "history_snapshot")
            ? { history_snapshot: entry.history_snapshot }
            : {}),
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
    provenance?: { originExecutionId?: string; historySnapshot?: unknown }
  ): void {
    if (!this.enabled) return;

    const target = this.entryPath(capability, key);
    const tmp = `${target}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;

    try {
      const dir = join(this.path, capability);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      }

      const entry: CacheEntry<T> = {
        key,
        payload,
        created_at: Date.now(),
        ttl_seconds: ttlSeconds,
        ...(provenance?.originExecutionId
          ? { origin_execution_id: provenance.originExecutionId }
          : {}),
        ...(provenance?.historySnapshot !== undefined
          ? { history_snapshot: provenance.historySnapshot }
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
   * Describe replay-cache storage for `cache stats`. This is replay-cache
   * state only — it says nothing about research-history counts.
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
    };

    if (!existsSync(this.path)) return stats;

    let oldest = Infinity;
    let newest = -Infinity;

    for (const capability of readdirSync(this.path)) {
      const capDir = join(this.path, capability);
      let capStats;
      try {
        capStats = statSync(capDir);
      } catch {
        continue;
      }
      if (!capStats.isDirectory()) continue;

      const perCap = { entries: 0, bytes: 0 };
      for (const file of readdirSync(capDir)) {
        if (!file.endsWith(".json")) continue;
        const filePath = join(capDir, file);
        try {
          const size = statSync(filePath).size;
          perCap.entries += 1;
          perCap.bytes += size;

          const entry = JSON.parse(readFileSync(filePath, "utf8")) as CacheEntry;
          if (
            typeof entry.created_at === "number" &&
            typeof entry.ttl_seconds === "number"
          ) {
            if (entry.created_at + entry.ttl_seconds * 1000 < Date.now()) {
              stats.expired_entries += 1;
            }
            oldest = Math.min(oldest, entry.created_at);
            newest = Math.max(newest, entry.created_at);
          }
        } catch {
          // Unreadable/corrupt file still counts as stored material (entries
          // and bytes above) but contributes no timing metadata.
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
   * Delete all replay-cache entries. History records are never touched (they
   * live outside this directory). Returns how many entries were removed plus
   * any non-secret removal errors.
   */
  clear(): CacheClearResult {
    const result: CacheClearResult = { removed: 0, errors: [] };
    if (!existsSync(this.path)) return result;

    for (const capability of readdirSync(this.path)) {
      const capDir = join(this.path, capability);
      try {
        if (!statSync(capDir).isDirectory()) continue;
      } catch {
        continue;
      }

      // A directory that cannot be enumerated must not abort the whole clear
      // after other directories were already partially deleted: report it as a
      // non-secret error and continue with the remaining capability
      // directories.
      let files: string[];
      try {
        files = readdirSync(capDir);
      } catch (error) {
        result.errors.push(
          `could not enumerate ${capability}/: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        continue;
      }

      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          unlinkSync(join(capDir, file));
          result.removed += 1;
        } catch (error) {
          result.errors.push(
            `could not remove ${capability}/${file}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    }

    return result;
  }
}
