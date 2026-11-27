/** Ledger and result text for a native call whose client stopped waiting for it. */
export const CANCELLED = "cancelled by the client";

/**
 * Throws once the calling agent has cancelled the tool call or its connection
 * has closed (the MCP request's abort signal). Called before each step that
 * would cost something: a request to the site, a pause at the host gate, a
 * page sent to the paid fallback.
 */
export function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error(CANCELLED);
}
