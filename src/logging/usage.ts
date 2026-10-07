import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { CapabilityName, KeyPool } from "../types.js";

export interface UsageLogEntry {
  timestamp: string;
  provider: string;
  capability?: CapabilityName;
  tool?: string;
  catalogued?: boolean;
  /** Agent run ID this usage entry belongs to (agent-triggered calls only). */
  run_id?: string;
  key: string;
  success: boolean;
  response_time_ms: number;
  error?: string;
  /** Bright Data only: masked zone suffix (never the full zone — embeds customer ID). */
  zone?: string;
  /** Provider-reported cost in USD where the tool summary extracts it. */
  cost_usd?: number;
  /** Result/record count where the tool summary extracts it. */
  result_count?: number;
}

function defaultUsageLogPath(): string {
  return join(homedir(), ".config", "coldsearch", "usage.jsonl");
}

function expandHome(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return join(homedir(), p.slice(2));
  }
  return p;
}

/** Never log raw literal API keys from config. */
export function safeKeyRef(keyRef: string, provider: string): string {
  if (keyRef.startsWith("env:") || keyRef.startsWith("doppler:")) {
    return keyRef;
  }
  return `${provider}:literal`;
}

/**
 * Safe key reference for dry-run / status display.
 */
export function getKeyReference(keyPool: KeyPool | undefined, provider: string): string {
  if (!keyPool?.keys?.length) return `${provider}:keyless`;
  return safeKeyRef(keyPool.keys[0], provider);
}

export class UsageLogger {
  private path: string;

  constructor(options?: { path?: string }) {
    this.path = expandHome(options?.path || defaultUsageLogPath());
  }

  getPath(): string {
    return this.path;
  }

  write(entry: UsageLogEntry): void {
    try {
      const dir = dirname(this.path);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      appendFileSync(this.path, `${JSON.stringify(entry)}\n`, "utf8");
    } catch {
      // Best-effort: logging failures must never break core operations.
    }
  }
}
