import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";

/** What one upstream call cost, in whichever unit the vendor reported. */
export interface CallCost {
  usd?: number;
  credits?: number;
}

/** One line of the gateway ledger: a single attempt against one upstream key. */
export interface LedgerEntry {
  ts: string;
  session: string;
  /** Name and version the connecting agent announced, when it did. */
  client?: string;
  upstream: string;
  tool: string;
  /** Key reference (`doppler:NAME`, `env:NAME`), never the key itself. */
  key: string;
  attempt: number;
  ok: boolean;
  duration_ms: number;
  /** `quota` means the key was out of credit and the gateway moved on. */
  error_class?: "quota" | "auth" | "upstream" | "gateway";
  error?: string;
  args?: string;
  result_bytes?: number;
  cost?: CallCost;
  /** File holding this attempt's full request and response, relative to the payload directory. */
  payload?: string;
}

const ARGS_LIMIT = 2000;
const ERROR_LIMIT = 300;

/** Replace every known secret value in `text` so it cannot reach disk. */
export function redact(text: string, secrets: Iterable<string>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 6) out = out.split(secret).join("[redacted]");
  }
  return out;
}

function numberAt(text: string, pattern: RegExp): number | undefined {
  const match = text.match(pattern);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Pull the vendor-reported cost out of a tool result. Vendors put it in
 * different places: Parallel in `_meta["parallel/usage"].cost_usd`, Exa as
 * `costDollars.total` and Firecrawl as `creditsUsed` inside the returned JSON.
 * Returns undefined when the result carries none of these.
 */
export function extractCost(result: unknown): CallCost | undefined {
  if (!result || typeof result !== "object") return undefined;
  const record = result as Record<string, unknown>;
  const cost: CallCost = {};

  const meta = record._meta;
  if (meta && typeof meta === "object") {
    for (const [key, value] of Object.entries(meta as Record<string, unknown>)) {
      if (!key.toLowerCase().includes("usage") || !value || typeof value !== "object") continue;
      const usd = (value as Record<string, unknown>).cost_usd;
      if (typeof usd === "number" && Number.isFinite(usd)) cost.usd = usd;
    }
  }

  const parts: string[] = [];
  if (record.structuredContent !== undefined) parts.push(JSON.stringify(record.structuredContent));
  if (Array.isArray(record.content)) {
    for (const item of record.content) {
      if (item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string") {
        parts.push((item as { text: string }).text);
      }
    }
  }
  const text = parts.join("\n");
  if (text) {
    const usd = numberAt(text, /"costDollars"\s*:\s*\{[^{}]*?"total"\s*:\s*([0-9.]+)/);
    const credits = numberAt(text, /"creditsUsed"\s*:\s*([0-9.]+)/);
    if (cost.usd === undefined && usd !== undefined) cost.usd = usd;
    if (credits !== undefined) cost.credits = credits;
  }

  return cost.usd === undefined && cost.credits === undefined ? undefined : cost;
}

export interface LedgerSummaryRow {
  upstream: string;
  key: string;
  calls: number;
  errors: number;
  quota_errors: number;
  usd: number;
  credits: number;
  last_call: string;
}

/** Which entries `Ledger.recent` returns. */
export interface LedgerQuery {
  /** Only entries whose `ts` is within this long before `now`. */
  sinceMs: number;
  /** Only entries for this upstream; every upstream when undefined. */
  upstream?: string;
  /** Return at most this many entries, the newest ones. */
  limit: number;
  now?: number;
}

export interface LedgerPage {
  /** Newest first by `ts`; entries with the same `ts` in reverse file order. */
  entries: LedgerEntry[];
  /** How many entries matched the query before `limit` was applied. */
  matched: number;
}

const READ_CHUNK_BYTES = 64 * 1024;

/** Add one ledger entry to the totals for its upstream and key. */
function addToSummary(rows: Map<string, LedgerSummaryRow>, entry: LedgerEntry): void {
  const id = `${entry.upstream}\u0000${entry.key}`;
  const row =
    rows.get(id) ??
    { upstream: entry.upstream, key: entry.key, calls: 0, errors: 0, quota_errors: 0, usd: 0, credits: 0, last_call: entry.ts };
  row.calls += 1;
  if (!entry.ok) row.errors += 1;
  if (entry.error_class === "quota") row.quota_errors += 1;
  row.usd += entry.cost?.usd ?? 0;
  row.credits += entry.cost?.credits ?? 0;
  if (entry.ts > row.last_call) row.last_call = entry.ts;
  rows.set(id, row);
}

function sortedSummary(rows: Map<string, LedgerSummaryRow>): LedgerSummaryRow[] {
  return [...rows.values()].sort((a, b) => a.upstream.localeCompare(b.upstream) || a.key.localeCompare(b.key));
}

/**
 * Append-only JSONL record of every call the gateway forwards. The file is
 * created 0600 because arguments can hold queries the operator considers
 * private.
 */
export class Ledger {
  constructor(
    private readonly path: string,
    private readonly logArguments: boolean,
    private readonly payloadDir?: string
  ) {}

  /**
   * Save one attempt's complete request and response as its own file
   * (`<day>/<time>-<id>.json`, mode 0600) and return its relative path. The
   * ledger line stays small enough to scan; the body is here when needed.
   * Returns undefined when payload logging is off or the write fails.
   */
  writePayload(
    entry: Pick<LedgerEntry, "ts" | "session" | "upstream" | "tool" | "key" | "attempt">,
    request: unknown,
    response: unknown,
    secrets: Iterable<string>
  ): string | undefined {
    if (!this.payloadDir) return undefined;
    try {
      const day = entry.ts.slice(0, 10);
      const id = `${entry.ts.slice(11, 23).replace(/[:.]/g, "")}-${entry.upstream}-${Math.random().toString(36).slice(2, 8)}`;
      const relative = join(day, `${id}.json`);
      mkdirSync(join(this.payloadDir, day), { recursive: true, mode: 0o700 });
      const body = redact(JSON.stringify({ ...entry, request, response }, null, 2), secrets);
      writeFileSync(join(this.payloadDir, relative), body, { mode: 0o600 });
      return relative;
    } catch (error) {
      process.stderr.write(`coldsearch gateway: payload write failed (${(error as Error).message})\n`);
      return undefined;
    }
  }

  getPath(): string {
    return this.path;
  }

  /** Serialize call arguments for the ledger, or undefined when disabled. */
  formatArgs(args: unknown, secrets: Iterable<string>): string | undefined {
    if (!this.logArguments || args === undefined) return undefined;
    let text: string;
    try {
      text = JSON.stringify(args);
    } catch {
      text = "[unserializable arguments]";
    }
    text = redact(text, secrets);
    return text.length > ARGS_LIMIT ? `${text.slice(0, ARGS_LIMIT)}…` : text;
  }

  formatError(error: string, secrets: Iterable<string>): string {
    const text = redact(error, secrets);
    return text.length > ERROR_LIMIT ? `${text.slice(0, ERROR_LIMIT)}…` : text;
  }

  /**
   * Write one entry. A ledger that cannot be written is reported on stderr
   * once per failure and never fails the tool call it describes.
   */
  append(entry: LedgerEntry): void {
    try {
      const fresh = !existsSync(this.path);
      if (fresh) mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
      if (fresh) chmodSync(this.path, 0o600);
    } catch (error) {
      process.stderr.write(`coldsearch gateway: ledger write failed (${(error as Error).message})\n`);
    }
  }

  /**
   * Call `visit` with every ledger entry, in file order.
   *
   * The file is read in fixed-size pieces and each read is awaited, so memory
   * does not grow with the file and other requests are served between pieces.
   * A ledger that does not exist yet has no entries, because the gateway
   * creates the file with its first call. Any other read failure throws,
   * naming the path. Lines that are not ledger entries, or whose `ts` is not
   * a time, are skipped.
   */
  private async scan(visit: (entry: LedgerEntry, at: number, line: number) => void): Promise<void> {
    let lineNumber = 0;
    const consider = (line: string): void => {
      lineNumber += 1;
      if (!line) return;
      let entry: LedgerEntry | null;
      try {
        entry = JSON.parse(line) as LedgerEntry | null;
      } catch {
        return;
      }
      if (!entry || typeof entry !== "object" || typeof entry.upstream !== "string" || typeof entry.tool !== "string") return;
      const at = typeof entry.ts === "string" ? Date.parse(entry.ts) : Number.NaN;
      if (Number.isFinite(at)) visit(entry, at, lineNumber);
    };

    try {
      const handle = await open(this.path, "r");
      try {
        const decoder = new StringDecoder("utf8");
        const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
        let rest = "";
        for (;;) {
          const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
          if (bytesRead === 0) break;
          const lines = (rest + decoder.write(chunk.subarray(0, bytesRead))).split("\n");
          rest = lines.pop() ?? "";
          for (const line of lines) consider(line);
        }
        consider(rest + decoder.end());
      } finally {
        await handle.close();
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return;
      throw new Error(`the ledger at ${this.path} could not be read (${err.code ?? err.message})`);
    }
  }

  /**
   * The newest entries matching `query`, newest first.
   *
   * Reads ledger lines only. An entry's `payload` field is returned as the
   * file name it is; the payload files themselves are never opened. At most
   * `2 * limit` entries are held at a time. Order comes from `ts`, not line
   * position: a line is written when its call ends, so a long call sits below
   * shorter ones that started after it.
   *
   * A ledger not written yet is an empty page; a ledger that cannot be read
   * throws (see `scan`).
   */
  async recent(query: LedgerQuery): Promise<LedgerPage> {
    const cutoff = (query.now ?? Date.now()) - query.sinceMs;
    const limit = Math.max(1, Math.floor(query.limit));
    let kept: Array<{ at: number; line: number; entry: LedgerEntry }> = [];
    let matched = 0;
    const newestFirst = (a: { at: number; line: number }, b: { at: number; line: number }) => b.at - a.at || b.line - a.line;

    await this.scan((entry, at, line) => {
      if (at < cutoff) return;
      if (query.upstream !== undefined && entry.upstream !== query.upstream) return;
      matched += 1;
      kept.push({ at, line, entry });
      if (kept.length >= limit * 2) kept = kept.sort(newestFirst).slice(0, limit);
    });
    return { entries: kept.sort(newestFirst).slice(0, limit).map((item) => item.entry), matched };
  }

  /**
   * Totals per upstream and key for each window in `windowsMs`: one list per
   * window, in the order given, each counting entries newer than that long
   * before `now`. The file is read once however many windows are asked for.
   *
   * Unlike `summarize`, this does not hold the whole file in memory or keep
   * the thread for the length of the read, and a ledger that cannot be read
   * throws instead of counting as empty. A ledger not written yet is empty.
   */
  async totals(windowsMs: number[], now: number = Date.now()): Promise<LedgerSummaryRow[][]> {
    const windows = windowsMs.map((ms) => ({ cutoff: now - ms, rows: new Map<string, LedgerSummaryRow>() }));
    await this.scan((entry, at) => {
      for (const window of windows) {
        if (at >= window.cutoff) addToSummary(window.rows, entry);
      }
    });
    return windows.map((window) => sortedSummary(window.rows));
  }

  /** Totals per upstream and key for entries newer than `sinceMs` ago. */
  summarize(sinceMs: number, now: number = Date.now()): LedgerSummaryRow[] {
    let content: string;
    try {
      content = readFileSync(this.path, "utf8");
    } catch {
      return [];
    }
    const cutoff = now - sinceMs;
    const rows = new Map<string, LedgerSummaryRow>();
    for (const line of content.split("\n")) {
      if (!line) continue;
      let entry: LedgerEntry;
      try {
        entry = JSON.parse(line) as LedgerEntry;
      } catch {
        continue;
      }
      if (Date.parse(entry.ts) < cutoff) continue;
      addToSummary(rows, entry);
    }
    return sortedSummary(rows);
  }
}
