/**
 * An Error carrying the category the CLI prints (`Error (config): …`), so a
 * `keys` failure is reported as what it is and not as a provider fault.
 * `config`: the `[keys]` table. `validation`: the command line.
 * `credentials`: reading or writing a secret.
 */
export function keysError(category: "config" | "validation" | "credentials", message: string): Error {
  return Object.assign(new Error(message), { category });
}
