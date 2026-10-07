/** Parse an agent LLM key reference without accepting inline credentials. */
export type AgentKeyRef = { kind: "env" | "doppler"; name: string };

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DOPPLER_PERMISSIVE_NAME = /^[A-Za-z0-9_/:.-]{1,200}$/;
const DOPPLER_RESERVED = new Set([
  "constructor", "prototype", "__proto__", "tostring", "valueof",
  "hasownproperty", "isprototypeof", "propertyisenumerable",
  "tolocalestring", "__definegetter__", "__definesetter__",
  "__lookupgetter__", "__lookupsetter__",
]);

/**
 * env references must be shell-compatible variable names. Doppler references
 * also support Doppler Permissive naming (letters, digits, `_/:.-`, up to 200
 * chars), while excluding Doppler's documented reserved names.
 */
export function parseAgentKeyRef(value: unknown): AgentKeyRef | undefined {
  if (typeof value !== "string") return undefined;
  if (value.startsWith("env:")) {
    const name = value.slice(4);
    return ENV_NAME.test(name) ? { kind: "env", name } : undefined;
  }
  if (value.startsWith("doppler:")) {
    const name = value.slice(8);
    const lowerName = name.toLowerCase();
    if (
      !DOPPLER_PERMISSIVE_NAME.test(name) ||
      /^DOPPLER_(PROJECT|ENVIRONMENT|CONFIG|CLI)$/i.test(name) ||
      /^DOPPLER_CLI_/i.test(name) ||
      DOPPLER_RESERVED.has(lowerName)
    ) return undefined;
    return { kind: "doppler", name };
  }
  return undefined;
}
