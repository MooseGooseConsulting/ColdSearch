import { open } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import type { LedgerEntry } from "../gateway/ledger.js";
import type { KeyProvider, KeyProviderConfig, KeysConfig, RotationPolicy } from "./config.js";
import { keysError } from "./errors.js";
import { dopplerStore, referencedSecret, type DopplerScope, type SecretStore } from "./doppler.js";
import { hasBalanceEndpoint, isUnknown, noEndpointReason, readAllowance, type Allowance } from "./readers.js";

/**
 * What the slot secret holds.
 * - `pool-reference`: a same-config reference to a pool member (the normal state).
 * - `other-reference`: a reference to something that is not a pool member.
 * - `own-value`: a value of its own, such as a key pasted straight into the slot.
 * - `unreadable`: Doppler could not be asked, or the secret does not exist.
 */
export type SlotState = "pool-reference" | "other-reference" | "own-value" | "unreadable";

/** One allowance: the pool keys that draw on it and what the provider says is left. */
export interface AccountStatus {
  /** Pool secret names that draw on this account, in pool order. */
  keys: string[];
  /** True when the slot references one of `keys`. */
  in_slot: boolean;
  remaining: number | null;
  limit: number | null;
  unit: string | null;
  period_end: string | null;
  /** True when `remaining` is at or below the floor; null when `remaining` is unknown. */
  spent: boolean | null;
  /** Why `remaining` is null; null when it was read. */
  unknown: string | null;
  /** Spend the gateway ledger recorded against these keys' references; null when not looked up or the ledger could not be read. */
  ledger_usd: number | null;
  ledger_calls: number | null;
}

/** One provider's slot and accounts. This is the `--json` shape of `keys status`. */
export interface ProviderKeyStatus {
  provider: KeyProvider;
  project: string;
  config: string;
  slot: string;
  slot_state: SlotState;
  /** Pool member the slot references; null unless `slot_state` is `pool-reference`. */
  points_at: string | null;
  /** What the slot holds instead, or why it could not be read; null when `points_at` is set. */
  slot_note: string | null;
  policy: RotationPolicy;
  floor: number;
  accounts: AccountStatus[];
  /** Ledger spend recorded against the slot's own reference, which no single account can claim. */
  slot_ledger_usd: number | null;
  slot_ledger_calls: number | null;
  /**
   * Why the ledger figures are null although a ledger was asked for: the file
   * is missing or could not be read. Null when it was read or not looked up.
   * Without this a ledger that is not there would read as no spend.
   */
  ledger_note: string | null;
}

export interface KeyStatusReport {
  providers: ProviderKeyStatus[];
}

/** Seams for tests: how secrets are reached. */
export interface KeysDeps {
  store?: (scope: DopplerScope) => SecretStore;
}

/** A provider's status plus what was learned on the way, for `keys rotate` and for redaction. */
export interface GatheredStatus {
  status: ProviderKeyStatus;
  store: SecretStore;
  /** Resolved pool key values read while gathering, by secret name. In memory only. */
  values: Map<string, string>;
  /** The slot's stored text when it is a value of its own. In memory only. */
  slotValue?: string;
}

/** The slot classified. `ownValue` is its stored text when that is a value of its own; never print it. */
export interface SlotReading {
  state: SlotState;
  pointsAt: string | null;
  note: string | null;
  ownValue?: string;
}

/** Text that is a Doppler reference and nothing else; safe to print because it names secrets, not values. */
const REFERENCE_TEXT = /^\$\{[A-Za-z0-9_.-]+\}$/;

/** Classify the slot's stored text without ever putting a key value in the result's printable fields. */
export async function readSlot(store: SecretStore, config: Pick<KeyProviderConfig, "slot" | "pool">): Promise<SlotReading> {
  let raw: string;
  try {
    raw = await store.getRaw(config.slot);
  } catch (error) {
    return { state: "unreadable", pointsAt: null, note: (error as Error).message };
  }
  const name = referencedSecret(raw);
  if (name && config.pool.includes(name)) return { state: "pool-reference", pointsAt: name, note: null };
  if (REFERENCE_TEXT.test(raw)) {
    return { state: "other-reference", pointsAt: null, note: `references ${raw}, which is not in the pool` };
  }
  return { state: "own-value", pointsAt: null, note: "holds its own value, not a reference to a pool member", ownValue: raw };
}

interface Spend {
  usd: number;
  calls: number;
}

/** Recorded spend per secret name, or why the ledger could not be read. */
export type LedgerReading = { totals: Map<string, Spend> } | { unread: string };

const LEDGER_CHUNK_BYTES = 64 * 1024;

/**
 * Total recorded spend per secret name over the whole gateway ledger. A
 * ledger entry's `key` is a reference (`doppler:NAME`, `env:NAME`); spend is
 * counted against NAME whichever upstream it was used for.
 *
 * Never throws. A ledger that is missing or cannot be read is returned as
 * `{ unread }` with the reason, because for the providers this serves the
 * ledger is the only figure shown and "no file" must not read as "no spend".
 * The file is read in fixed-size chunks, so memory stays flat however large
 * an append-only ledger has grown; lines that are not ledger entries are
 * skipped.
 */
export async function ledgerSpend(ledgerPath: string): Promise<LedgerReading> {
  const totals = new Map<string, Spend>();
  const count = (line: string): void => {
    if (!line) return;
    let entry: Partial<LedgerEntry> | null;
    try {
      entry = JSON.parse(line) as Partial<LedgerEntry> | null;
    } catch {
      return;
    }
    if (!entry || typeof entry !== "object" || typeof entry.key !== "string") return;
    const name = entry.key.replace(/^(doppler|env):/, "");
    const total = totals.get(name) ?? { usd: 0, calls: 0 };
    const usd = entry.cost?.usd;
    total.usd += typeof usd === "number" && Number.isFinite(usd) ? usd : 0;
    total.calls += 1;
    totals.set(name, total);
  };

  try {
    const handle = await open(ledgerPath, "r");
    try {
      const decoder = new StringDecoder("utf8");
      const chunk = Buffer.allocUnsafe(LEDGER_CHUNK_BYTES);
      let rest = "";
      for (;;) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (bytesRead === 0) break;
        const lines = (rest + decoder.write(chunk.subarray(0, bytesRead))).split("\n");
        rest = lines.pop() ?? "";
        for (const line of lines) count(line);
      }
      count(rest + decoder.end());
    } finally {
      await handle.close();
    }
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    return {
      unread:
        err.code === "ENOENT"
          ? `no ledger file at ${ledgerPath}`
          : `the ledger at ${ledgerPath} could not be read (${err.code ?? err.message})`,
    };
  }
  return { totals };
}

/**
 * Read one provider's slot and every pool account's allowance.
 *
 * Never throws for a provider or Doppler failure: what could not be read is
 * reported in place, with the reason. For a provider with no balance endpoint
 * the pool keys are not resolved at all, and spend comes from `ledger` when
 * one is given: a `ledgerSpend` call the caller started, so one run reads the
 * file once however many providers use it.
 */
export async function gatherProviderStatus(
  config: KeyProviderConfig,
  ledger: Promise<LedgerReading> | undefined,
  deps: KeysDeps = {}
): Promise<GatheredStatus> {
  const store = (deps.store ?? dopplerStore)({ project: config.project, config: config.config });
  const values = new Map<string, string>();
  const metered = hasBalanceEndpoint(config.provider);

  const [slot, readings, ledgerReading] = await Promise.all([
    readSlot(store, config),
    Promise.all(
      config.pool.map(async (name): Promise<Allowance> => {
        if (!metered) return { unknown: noEndpointReason(config.provider) };
        let value: string;
        try {
          value = await store.get(name);
        } catch (error) {
          return { unknown: (error as Error).message };
        }
        values.set(name, value);
        return readAllowance(config.provider, value, config.baseUrl);
      })
    ),
    metered ? undefined : ledger,
  ]);

  const spend = ledgerReading && "totals" in ledgerReading ? ledgerReading.totals : undefined;
  const ledgerNote = ledgerReading && "unread" in ledgerReading ? ledgerReading.unread : null;

  // Keys whose readings prove one account share a row; everything else stands alone.
  const groups = new Map<string, { keys: string[]; reading: Allowance }>();
  config.pool.forEach((name, index) => {
    const reading = readings[index];
    const proof = !isUnknown(reading) && reading.account ? `account:${reading.account}` : `key:${name}`;
    const group = groups.get(proof);
    if (group) group.keys.push(name);
    else groups.set(proof, { keys: [name], reading });
  });

  const accounts = [...groups.values()].map(({ keys, reading }): AccountStatus => {
    const recorded = spend ? keys.map((key) => spend.get(key) ?? { usd: 0, calls: 0 }) : undefined;
    const known = isUnknown(reading) ? undefined : reading;
    return {
      keys,
      in_slot: slot.pointsAt !== null && keys.includes(slot.pointsAt),
      remaining: known?.remaining ?? null,
      limit: known?.limit ?? null,
      unit: known?.unit ?? null,
      period_end: known?.period_end ?? null,
      spent: known ? known.remaining <= config.floor : null,
      unknown: isUnknown(reading) ? reading.unknown : null,
      ledger_usd: recorded ? recorded.reduce((sum, item) => sum + item.usd, 0) : null,
      ledger_calls: recorded ? recorded.reduce((sum, item) => sum + item.calls, 0) : null,
    };
  });

  const slotSpend = spend ? spend.get(config.slot) ?? { usd: 0, calls: 0 } : undefined;
  return {
    store,
    values,
    slotValue: slot.ownValue,
    status: {
      provider: config.provider,
      project: config.project,
      config: config.config,
      slot: config.slot,
      slot_state: slot.state,
      points_at: slot.pointsAt,
      slot_note: slot.note,
      policy: config.policy,
      floor: config.floor,
      accounts,
      slot_ledger_usd: slotSpend?.usd ?? null,
      slot_ledger_calls: slotSpend?.calls ?? null,
      ledger_note: ledgerNote,
    },
  };
}

/** Status for every configured provider, or only `provider` when given. Also returns every key value read, for redaction. */
export async function collectKeyStatus(
  config: KeysConfig,
  provider?: string,
  deps: KeysDeps = {}
): Promise<{ report: KeyStatusReport; secrets: string[] }> {
  const chosen = provider ? config.providers.filter((item) => item.provider === provider) : config.providers;
  if (chosen.length === 0) {
    throw keysError(
      "config",
      `[keys] no [keys.${provider}] block in the config; configured: ${config.providers.map((item) => item.provider).join(", ")}`
    );
  }
  // Only providers with no balance endpoint show ledger spend; read the file once for all of them.
  const ledger =
    config.ledgerPath && chosen.some((item) => !hasBalanceEndpoint(item.provider)) ? ledgerSpend(config.ledgerPath) : undefined;
  const gathered = await Promise.all(chosen.map((item) => gatherProviderStatus(item, ledger, deps)));
  return {
    report: { providers: gathered.map((item) => item.status) },
    secrets: gathered.flatMap((item) => [...item.values.values(), ...(item.slotValue ? [item.slotValue] : [])]),
  };
}

function spendText(amount: number, calls: number): string {
  return `$${amount.toFixed(2)} over ${calls} call${calls === 1 ? "" : "s"}`;
}

function accountNote(account: AccountStatus): string {
  const notes: string[] = [];
  if (account.unknown) notes.push(account.unknown);
  if (account.spent) notes.push("at or below the floor");
  if (account.keys.length > 1) notes.push("one account");
  if (account.ledger_calls !== null && account.ledger_usd !== null) {
    notes.push(`ledger: ${spendText(account.ledger_usd, account.ledger_calls)}`);
  }
  return notes.join("; ");
}

/** The compact table `keys status` prints. `*` marks the account the slot points at. */
export function formatKeyStatus(report: KeyStatusReport): string {
  const blocks = report.providers.map((provider) => {
    const target = provider.points_at ?? `(${provider.slot_note})`;
    const lines = [`${provider.provider}: ${provider.slot} -> ${target}   policy ${provider.policy}, floor ${provider.floor}`];
    if (provider.ledger_note) lines.push(`  ledger not read: ${provider.ledger_note}`);
    if (provider.slot_ledger_calls) {
      lines.push(`  ledger: ${spendText(provider.slot_ledger_usd ?? 0, provider.slot_ledger_calls)} made with ${provider.slot} itself`);
    }
    const rows = [
      ["", "KEYS", "REMAINING", "LIMIT", "PERIOD ENDS", "NOTE"],
      ...provider.accounts.map((account) => [
        account.in_slot ? "*" : "",
        account.keys.join(", "),
        account.remaining === null ? "?" : String(account.remaining),
        account.limit === null ? "-" : String(account.limit),
        account.period_end?.slice(0, 10) ?? "-",
        accountNote(account),
      ]),
    ];
    const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
    for (const row of rows) {
      const cells = row.map((cell, column) =>
        column === 2 || column === 3 ? cell.padStart(widths[column]) : cell.padEnd(widths[column])
      );
      lines.push(`  ${cells.join("  ")}`.trimEnd());
    }
    return lines.join("\n");
  });
  return blocks.join("\n\n");
}
