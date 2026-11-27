import { execFile } from "node:child_process";
import { keysError } from "./errors.js";

/** The Doppler project and config every call names explicitly. */
export interface DopplerScope {
  project: string;
  config: string;
}

/**
 * The three secret operations `coldsearch keys` needs. `dopplerStore` runs
 * them through the Doppler CLI; tests may supply another implementation.
 */
export interface SecretStore {
  /** The secret's value with references resolved. Rejects when it is missing or empty. */
  get(name: string): Promise<string>;
  /** The secret's stored text, references left as written (`${OTHER}`). */
  getRaw(name: string): Promise<string>;
  /** Replace the secret's stored text. */
  set(name: string, value: string): Promise<void>;
}

const TIMEOUT_MS = 15_000;

/**
 * Run `doppler` with `args`, optionally feeding `stdin`, and return stdout.
 *
 * No shell: `execFile` passes each argument as a literal argv entry. A value
 * being written goes on stdin only, so it cannot be read from the process
 * list. A failure is reported by exit status with the CLI's first stderr
 * line; stdout is never put in an error because it can hold a secret.
 */
function runDoppler(args: string[], stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile("doppler", args, { encoding: "utf8", timeout: TIMEOUT_MS }, (error, stdout, stderr) => {
      if (!error) {
        resolve(stdout);
        return;
      }
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error("Doppler CLI not found on PATH. Install it from https://docs.doppler.com/docs/cli"));
        return;
      }
      const detail = String(stderr).trim().split("\n")[0]?.slice(0, 200);
      reject(new Error(detail || (error.killed ? "the Doppler CLI timed out" : "the Doppler CLI failed")));
    });
    // The CLI may exit before reading stdin; that surfaces through the callback.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(stdin ?? "");
  });
}

/**
 * Secret access through the `doppler` CLI for one project and config.
 *
 * Every call passes `-p` and `-c`, so the directory the command runs from and
 * any `doppler setup` scope have no say in which config is read or written.
 * Error messages name the secret, project and config, never a value.
 */
export function dopplerStore(scope: DopplerScope): SecretStore {
  const where = ["-p", scope.project, "-c", scope.config];
  const describe = (name: string) => `${name} in Doppler ${scope.project}/${scope.config}`;

  const read = async (name: string, raw: boolean): Promise<string> => {
    let stdout: string;
    try {
      stdout = await runDoppler(["secrets", "get", name, "--plain", ...(raw ? ["--raw"] : []), ...where]);
    } catch (error) {
      throw keysError("credentials", `Could not read ${describe(name)}: ${(error as Error).message}`);
    }
    const value = stdout.trim();
    if (!value) throw keysError("credentials", `${describe(name)} is empty`);
    return value;
  };

  return {
    get: (name) => read(name, false),
    getRaw: (name) => read(name, true),
    set: async (name, value) => {
      try {
        // --silent: without it the CLI prints the secret it just stored.
        // --no-interactive: fail instead of prompting if stdin were ever a terminal.
        await runDoppler(["secrets", "set", name, "--silent", "--no-interactive", ...where], value);
      } catch (error) {
        throw keysError("credentials", `Could not write ${describe(name)}: ${(error as Error).message}`);
      }
    },
  };
}

/** The reference text that makes a slot resolve to `target` in the same config. */
export function referenceTo(target: string): string {
  return `\${${target}}`;
}

/**
 * The secret name a stored value refers to when it is exactly one same-config
 * reference (`${NAME}`), otherwise undefined. A cross-config reference, a
 * value with text around the reference, and a plain key all return undefined.
 */
export function referencedSecret(raw: string): string | undefined {
  return raw.trim().match(/^\$\{([A-Z_][A-Z0-9_]*)\}$/)?.[1];
}
