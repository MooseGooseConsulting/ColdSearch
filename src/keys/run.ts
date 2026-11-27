import { loadConfig } from "../config.js";
import { redact } from "../gateway/ledger.js";
import { resolveKeysConfig } from "./config.js";
import { keysError } from "./errors.js";
import { formatRotation, rotateSlot } from "./rotate.js";
import { collectKeyStatus, formatKeyStatus, type KeysDeps } from "./status.js";

export const KEYS_HELP = `coldsearch keys - what each provider account has left, and which one the slot uses

Usage:
  coldsearch keys status [options]             Show each provider's slot and accounts
  coldsearch keys rotate <provider> [options]  Point the slot at another pool key

A slot is the one secret every tool reads for a provider (FIRECRAWL_API_KEY).
Its value is a reference to one pool secret; rotating rewrites the reference.

Status options:
  --provider NAME     Only this provider
  --json              Machine-readable output (see docs/components/keys.md)

Rotate options:
  --to SECRET_NAME    Point the slot at this pool secret instead of applying
                      the provider's policy
  --dry-run           Say what would change; write nothing

Common options:
  -c, --config PATH   Config file with [keys.<provider>] blocks
  -h, --help          Show this help

Exit status: 0 when the slot is, or with --dry-run would be, where it should
be; 1 when nothing could be chosen or an error stopped the command.
`;

interface KeysCliOptions {
  command?: "status" | "rotate";
  provider?: string;
  configPath?: string;
  json: boolean;
  to?: string;
  dryRun: boolean;
  help: boolean;
}

export function parseKeysArgs(args: string[]): KeysCliOptions {
  const options: KeysCliOptions = { json: false, dryRun: false, help: false };
  const value = (index: number, flag: string): string => {
    const next = args[index + 1];
    if (next === undefined || next.startsWith("-")) throw keysError("validation", `${flag} requires a value`);
    return next;
  };
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "-c":
      case "--config":
        options.configPath = value(i++, arg);
        break;
      case "--provider":
        options.provider = value(i++, arg);
        break;
      case "--to":
        options.to = value(i++, arg);
        break;
      case "--json":
        options.json = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      default:
        if (arg.startsWith("-")) throw keysError("validation", `Unknown option for keys: ${arg}`);
        positional.push(arg);
    }
  }
  if (options.help) return options;

  const [command, ...rest] = positional;
  if (command === "status") {
    if (rest.length > 0) throw keysError("validation", "keys status takes no arguments; use --provider NAME to show one provider");
    if (options.to !== undefined || options.dryRun) throw keysError("validation", "--to and --dry-run belong to keys rotate");
    options.command = "status";
  } else if (command === "rotate") {
    if (rest.length !== 1) throw keysError("validation", "keys rotate needs exactly one provider, e.g. coldsearch keys rotate firecrawl");
    if (options.provider !== undefined || options.json) throw keysError("validation", "--provider and --json belong to keys status");
    options.command = "rotate";
    options.provider = rest[0];
  } else {
    throw keysError("validation", 'keys needs a command: "status" or "rotate" (see: coldsearch keys --help)');
  }
  return options;
}

/**
 * Entry point for `coldsearch keys`. Resolves to the process exit status.
 * Everything printed passes through redaction against every key value read
 * during the run.
 */
export async function runKeysCli(args: string[], deps: KeysDeps = {}): Promise<number> {
  const options = parseKeysArgs(args);
  if (options.help) {
    console.log(KEYS_HELP);
    return 0;
  }

  const raw = (loadConfig(options.configPath) as unknown as { keys?: unknown }).keys;
  const config = resolveKeysConfig(raw);

  if (options.command === "status") {
    const { report, secrets } = await collectKeyStatus(config, options.provider, deps);
    console.log(redact(options.json ? JSON.stringify(report, null, 2) : formatKeyStatus(report), secrets));
    return 0;
  }

  const provider = config.providers.find((item) => item.provider === options.provider);
  if (!provider) {
    throw keysError(
      "config",
      `[keys] no [keys.${options.provider}] block in the config; configured: ${config.providers.map((item) => item.provider).join(", ")}`
    );
  }
  const result = await rotateSlot(provider, config.ledgerPath, { to: options.to, dryRun: options.dryRun }, deps);
  const text = redact(formatRotation(result), result.secrets);
  if (result.outcome === "refused") {
    console.error(text);
    return 1;
  }
  console.log(text);
  return 0;
}
