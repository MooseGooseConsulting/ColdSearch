import type { KeyProviderConfig } from "./config.js";
import { dopplerStore, referenceTo, referencedSecret } from "./doppler.js";
import { keysError } from "./errors.js";
import { hasBalanceEndpoint } from "./readers.js";
import {
  gatherProviderStatus,
  readSlot,
  type AccountStatus,
  type KeysDeps,
  type ProviderKeyStatus,
  type SlotReading,
} from "./status.js";

/** The pool member a policy settled on, or why it settled on none. */
export type RotationChoice = { target: string; why: string } | { target: null; why: string };

function periodEnd(account: AccountStatus): number | undefined {
  const time = account.period_end ? Date.parse(account.period_end) : Number.NaN;
  return Number.isFinite(time) ? time : undefined;
}

/**
 * Apply the provider's policy to a status reading.
 *
 * - `in-order`: the first account in pool order that is above the floor.
 *   For a provider with no usage endpoint (exa, parallel) no allowance is
 *   ever known, and unknown counts as above. For a provider that has one, an
 *   account whose read failed is passed over: a rejected key, an HTTP error
 *   or a timeout says nothing about what is left, and counting it as above
 *   would move the slot onto a revoked or drained account.
 * - `soonest-reset`: among accounts known to be above the floor, the one
 *   whose period ends soonest, so allowance about to lapse is used first.
 *   When no such account reports a period end, the one with the most left.
 *   An account whose allowance is unknown is never picked by this policy.
 *
 * A policy chooses an account. Within it the key the slot already references
 * is kept, because another key of the same account spends the same
 * allowance; otherwise the account's first key in pool order is used.
 * `target` is null when no account qualifies; nothing should then change.
 */
export function chooseRotationTarget(status: ProviderKeyStatus): RotationChoice {
  const { accounts, floor, policy } = status;
  const unknown = accounts.filter((account) => account.remaining === null);
  const noneLeft = (): RotationChoice => {
    if (unknown.length === 0) {
      return { target: null, why: `every ${status.provider} account is at or below the floor of ${floor}` };
    }
    return {
      target: null,
      why:
        `no ${status.provider} account is known to be above the floor of ${floor}: ` +
        `${unknown.length} of ${accounts.length} could not be read (${unknown[0].unknown}). ` +
        `Policy "${policy}" needs a reading; pass --to to choose a pool key yourself`,
    };
  };
  const keyOf = (account: AccountStatus): string =>
    status.points_at && account.keys.includes(status.points_at) ? status.points_at : account.keys[0];

  if (policy === "in-order") {
    const unmetered = !hasBalanceEndpoint(status.provider);
    const position = accounts.findIndex((account) => account.spent === false || (unmetered && account.spent === null));
    if (position === -1) return noneLeft();
    const account = accounts[position];
    const earlier = accounts.slice(0, position);
    const spentEarlier = earlier.filter((item) => item.spent === true).length;
    const unreadEarlier = earlier.length - spentEarlier;
    const notes = [
      account.remaining === null
        ? `allowance unknown, which counts as above the floor because ${status.provider} has no balance endpoint`
        : `${account.remaining} left`,
      ...(spentEarlier > 0 ? [`${spentEarlier} earlier in the pool at or below the floor`] : []),
      ...(unreadEarlier > 0 ? [`${unreadEarlier} earlier in the pool could not be read`] : []),
    ];
    return { target: keyOf(account), why: `in-order: first pool account above the floor of ${floor} (${notes.join("; ")})` };
  }

  const above = accounts.filter((account) => account.spent === false);
  if (above.length === 0) return noneLeft();
  const mostLeft = (a: AccountStatus, b: AccountStatus) => (b.remaining ?? 0) - (a.remaining ?? 0);
  const dated = above.filter((account) => periodEnd(account) !== undefined);
  if (dated.length > 0) {
    const account = dated.sort((a, b) => periodEnd(a)! - periodEnd(b)! || mostLeft(a, b))[0];
    return {
      target: keyOf(account),
      why: `soonest-reset: its period ends ${account.period_end!.slice(0, 10)}, the soonest of ${above.length} accounts above the floor of ${floor} (${account.remaining} left)`,
    };
  }
  const account = [...above].sort(mostLeft)[0];
  return {
    target: keyOf(account),
    why: `soonest-reset: no account reports a period end, so the one with the most left (${account.remaining}) of ${above.length} above the floor of ${floor}`,
  };
}

export interface RotateOptions {
  /** Pool secret name to point the slot at, bypassing the policy. */
  to?: string;
  /** Decide and report, but write nothing. */
  dryRun?: boolean;
}

export interface RotationResult {
  provider: string;
  slot: string;
  /** What the slot held before, in words safe to print. */
  was: string;
  /** Pool member the slot should reference; null when no account qualifies. */
  target: string | null;
  why: string;
  /**
   * - `rotated`: the slot was rewritten and read back.
   * - `dry-run`: it would have been rewritten.
   * - `unchanged`: it already references the target.
   * - `refused`: nothing was written; `why` says what stands in the way.
   */
  outcome: "rotated" | "dry-run" | "unchanged" | "refused";
  /** Key values read on the way, for redacting output. In memory only. */
  secrets: string[];
}

/**
 * Point a provider's slot at a pool member by writing `${TARGET}` to it.
 *
 * Nothing is written when the slot already references the target, when no
 * account qualifies, when the slot cannot be read, or when the slot holds a
 * value of its own that is not also stored under a pool name (writing a
 * reference over it would lose that key). The target is resolved before the
 * write, and afterwards the slot must store the reference and resolve to the
 * target's value; otherwise this throws, naming the slot to check.
 */
export async function rotateSlot(
  config: KeyProviderConfig,
  options: RotateOptions = {},
  deps: KeysDeps = {}
): Promise<RotationResult> {
  if (options.to !== undefined && !config.pool.includes(options.to)) {
    throw keysError(
      "validation",
      `--to must name a secret in [keys.${config.provider}] pool: ${config.pool.join(", ")}`
    );
  }

  const values = new Map<string, string>();
  let store = (deps.store ?? dopplerStore)({ project: config.project, config: config.config });
  let slot: SlotReading;
  let choice: RotationChoice;
  if (options.to !== undefined) {
    slot = await readSlot(store, config);
    choice = { target: options.to, why: "chosen with --to" };
  } else {
    // No ledger: a policy chooses on allowance readings, never on recorded spend.
    const gathered = await gatherProviderStatus(config, undefined, deps);
    store = gathered.store;
    for (const [name, value] of gathered.values) values.set(name, value);
    const { status } = gathered;
    slot = { state: status.slot_state, pointsAt: status.points_at, note: status.slot_note, ownValue: gathered.slotValue };
    choice = chooseRotationTarget(status);
  }

  const secrets = () => [...values.values(), ...(slot.ownValue ? [slot.ownValue] : [])];
  const result = (outcome: RotationResult["outcome"], why: string, was: string): RotationResult => ({
    provider: config.provider,
    slot: config.slot,
    was,
    target: choice.target,
    why,
    outcome,
    secrets: secrets(),
  });
  let was = slot.pointsAt ?? `(${slot.note})`;

  if (choice.target === null) return result("refused", choice.why, was);
  const target = choice.target;
  if (slot.state === "unreadable") {
    return result("refused", `the slot could not be read, so it was left alone: ${slot.note}`, was);
  }
  if (slot.pointsAt === target) return result("unchanged", `${config.slot} already points at ${target} (${choice.why})`, was);

  const resolve = async (name: string): Promise<string> => {
    const known = values.get(name) ?? (await store.get(name));
    values.set(name, known);
    return known;
  };

  if (slot.state === "own-value") {
    // The slot's value is a key. Overwrite it only when a pool secret holds the same key.
    const held = await store.get(config.slot);
    values.set(config.slot, held);
    let twin: string | undefined;
    for (const name of config.pool) {
      const value = await resolve(name).catch(() => undefined);
      if (value === held) {
        twin = name;
        break;
      }
    }
    if (!twin) {
      return result(
        "refused",
        `${config.slot} holds its own value and no pool secret holds the same one, so writing a reference over it would lose that key. ` +
          `Store it under a pool name first, then rotate`,
        was
      );
    }
    was = `its own value, the same as ${twin}`;
  }

  const targetValue = await resolve(target);
  if (options.dryRun) return result("dry-run", choice.why, was);

  await store.set(config.slot, referenceTo(target));

  const stored = referencedSecret(await store.getRaw(config.slot));
  const resolved = await store.get(config.slot);
  if (stored !== target || resolved !== targetValue) {
    throw keysError(
      "credentials",
      `${config.slot} was written but does not read back as a reference to ${target}; check it in Doppler ${config.project}/${config.config} now`
    );
  }
  return result("rotated", choice.why, was);
}

/** The lines `keys rotate` prints for a result. */
export function formatRotation(result: RotationResult): string {
  const head = `${result.provider}: ${result.slot}`;
  switch (result.outcome) {
    case "rotated":
      return `${head}\n  was: ${result.was}\n  now: ${result.target}\n  why: ${result.why}`;
    case "dry-run":
      return `${head}\n  was: ${result.was}\n  would be: ${result.target}\n  why: ${result.why}\n  dry run: nothing changed`;
    case "unchanged":
      return `${head}\n  unchanged: ${result.why}`;
    case "refused":
      return `${head}\n  was: ${result.was}\n  nothing changed: ${result.why}`;
  }
}
