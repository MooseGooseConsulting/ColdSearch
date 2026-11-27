import { pageUrl } from "./urls.js";

/** A tool argument the agent got wrong. The message names the argument and is returned to the agent as is. */
export class ArgumentError extends Error {}

type Args = Record<string, unknown>;

export function urlArg(args: Args, name: string): URL {
  const value = args[name];
  const url = typeof value === "string" ? pageUrl(value.trim()) : undefined;
  if (!url) throw new ArgumentError(`${name} must be an http or https URL`);
  return url;
}

/** A whole number at least `min`. A value above `max` is lowered to `max`. */
export function intArg(args: Args, name: string, range: { min: number; max: number; fallback: number }): number {
  const value = args[name];
  if (value === undefined || value === null) return range.fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < range.min) {
    throw new ArgumentError(`${name} must be a whole number of at least ${range.min}`);
  }
  return Math.min(value, range.max);
}

export function boolArg(args: Args, name: string): boolean {
  const value = args[name];
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") throw new ArgumentError(`${name} must be true or false`);
  return value;
}

export function enumArg<T extends string>(args: Args, name: string, allowed: readonly T[], fallback: T): T {
  const value = args[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ArgumentError(`${name} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

export function patternsArg(args: Args, name: string): string[] {
  const value = args[name];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new ArgumentError(`${name} must be a list of path patterns such as "/docs/*"`);
  }
  return value as string[];
}
