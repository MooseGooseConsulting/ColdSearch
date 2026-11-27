import { lookup as dnsLookup } from "node:dns/promises";
import http, { type IncomingHttpHeaders } from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import type { Readable } from "node:stream";
import zlib from "node:zlib";

/**
 * The one SSRF guard in the repository (ADR 004). Agent mode's `fetch` tool
 * and the gateway's native fetch, map and crawl tools all validate a URL here
 * and then connect to the exact address that passed, so a second DNS answer
 * cannot swap in an internal address between the check and the connection.
 */

/** A URL that passed validation, with the address the request must connect to. */
export interface ValidatedFetchTarget {
  url: URL;
  resolvedAddress: string;
  family: 4 | 6;
}

/**
 * Seams for tests only. Production callers pass none of these; nothing in a
 * config file, environment variable or tool argument can set them.
 */
export interface SafeFetchHooks {
  /** Replaces DNS, so a test can give its local server a realistic hostname. */
  lookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  /**
   * Lets one otherwise blocked address through (a test's `127.0.0.1` server).
   * Blocked hostnames such as `localhost` and the metadata names stay blocked.
   */
  unsafeAllowAddress?: (address: string) => boolean;
}

function isIPv4InCidr(ip: string, network: string, prefixBits: number): boolean {
  const ipOctets = ip.split(".").map(Number);
  const networkOctets = network.split(".").map(Number);

  if (
    ipOctets.length !== 4 ||
    networkOctets.length !== 4 ||
    ipOctets.some(Number.isNaN) ||
    networkOctets.some(Number.isNaN)
  ) {
    return false;
  }

  const ipValue = ipOctets.reduce((value, octet) => ((value << 8) + octet) >>> 0, 0);
  const networkValue = networkOctets.reduce(
    (value, octet) => ((value << 8) + octet) >>> 0,
    0
  );
  const mask = prefixBits === 0 ? 0 : (~((1 << (32 - prefixBits)) - 1)) >>> 0;

  return (ipValue & mask) === (networkValue & mask);
}

/**
 * The eight 16-bit groups of an IPv6 address in any of its written forms
 * ("::" shorthand, a dotted IPv4 tail, a zone suffix), or null when the text
 * is not one. Ranges are then compared as numbers, so a reserved address
 * cannot slip past by being written another way.
 */
function ipv6Groups(address: string): number[] | null {
  let text = address.split("%")[0].toLowerCase();
  const tail = text.slice(text.lastIndexOf(":") + 1);
  if (tail.includes(".")) {
    const octets = tail.split(".").map(Number);
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
    const hex = (hi: number, lo: number): string => ((hi << 8) | lo).toString(16);
    text = `${text.slice(0, text.length - tail.length)}${hex(octets[0], octets[1])}:${hex(octets[2], octets[3])}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;

  const groups = [...head, ...Array<string>(missing).fill("0"), ...rest].map((group) =>
    /^[0-9a-f]{1,4}$/.test(group) ? Number.parseInt(group, 16) : Number.NaN
  );
  return groups.some(Number.isNaN) ? null : groups;
}

const ipv4FromGroups = (hi: number, lo: number): string => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;

/**
 * True for an address that is not on the public internet: loopback, private,
 * carrier-grade NAT, link-local and unspecified addresses, and an IPv6
 * address that carries one of those IPv4 addresses inside it (the ranges in
 * ADR 004).
 */
export function isBlockedIpAddress(address: string): boolean {
  const version = isIP(address);

  if (version === 4) {
    const blockedCidrs: Array<[string, number]> = [
      ["127.0.0.0", 8],
      ["10.0.0.0", 8],
      ["172.16.0.0", 12],
      ["192.168.0.0", 16],
      ["169.254.0.0", 16],
      ["0.0.0.0", 8],
      // Shared address space (RFC 6598): carrier-grade NAT, and the range
      // overlay networks such as Tailscale hand out, so on a machine in one
      // it is the internal network.
      ["100.64.0.0", 10],
    ];

    return blockedCidrs.some(([network, prefixBits]) =>
      isIPv4InCidr(address, network, prefixBits)
    );
  }

  if (version === 6) {
    const groups = ipv6Groups(address);
    // Node accepted it and this parser did not: refuse rather than guess.
    if (!groups) return true;
    const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
    const leadingZeros = (count: number): boolean => groups.slice(0, count).every((group) => group === 0);

    // :: (unspecified), ::1 (loopback) and the retired IPv4-compatible ::a.b.c.d.
    if (leadingZeros(6)) return true;
    // IPv4-mapped, ::ffff:a.b.c.d in any spelling: judged as the IPv4 address it is.
    if (leadingZeros(5) && g5 === 0xffff) return isBlockedIpAddress(ipv4FromGroups(g6, g7));
    // NAT64 (RFC 6052), 64:ff9b::/96: a gateway on the network forwards it to
    // the IPv4 address in the last 32 bits, so that address decides.
    if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
      return isBlockedIpAddress(ipv4FromGroups(g6, g7));
    }
    // Local-use NAT64 (RFC 8215), 64:ff9b:1::/48: internal by definition.
    if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return true;
    // Unique local fc00::/7, link-local fe80::/10.
    return (g0 & 0xfe00) === 0xfc00 || (g0 & 0xffc0) === 0xfe80;
  }

  return false;
}

function normalizeHostname(hostname: string): string {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

function isBlockedHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "metadata.google.internal" ||
    normalized === "metadata" ||
    normalized === "169.254.169.254"
  );
}

/**
 * Check one URL before any connection is opened: http or https only, no
 * internal hostname, no non-public literal address, and no hostname that
 * resolves to a non-public address (one bad answer refuses the host).
 * Throws an error that names the refused host. A redirect target must be
 * passed through here again before it is followed.
 */
export async function validateFetchUrl(url: string | URL, hooks: SafeFetchHooks = {}): Promise<ValidatedFetchTarget> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(`Invalid fetch URL: ${String(url)}`);
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error(`Unsupported fetch URL protocol: ${parsedUrl.protocol}`);
  }

  const host = normalizeHostname(parsedUrl.hostname);

  if (isBlockedHostname(host)) {
    throw new Error(`Refusing to fetch internal hostname: ${host}`);
  }

  const blocked = (address: string): boolean =>
    isBlockedIpAddress(address) && !hooks.unsafeAllowAddress?.(address);

  if (blocked(host)) {
    throw new Error(`Refusing to fetch non-public IP: ${host}`);
  }

  const resolvedAddresses = hooks.lookup
    ? await hooks.lookup(host)
    : await dnsLookup(host, { all: true, verbatim: true });
  if (resolvedAddresses.some((entry) => blocked(entry.address))) {
    throw new Error(
      `Refusing to fetch hostname resolving to a non-public IP: ${parsedUrl.hostname}`
    );
  }

  const preferredAddress = resolvedAddresses.find(
    (entry): entry is { address: string; family: 4 | 6 } => entry.family === 4 || entry.family === 6
  );

  if (!preferredAddress) {
    throw new Error(`Unable to resolve a public IP for hostname: ${parsedUrl.hostname}`);
  }

  return {
    url: parsedUrl,
    resolvedAddress: preferredAddress.address,
    family: preferredAddress.family,
  };
}

export interface PinnedRequestOptions {
  headers: Record<string, string>;
  /** Longest the connection may sit idle. */
  timeoutMs: number;
  /** Longest the whole exchange may take; unset means only the idle timeout applies. */
  deadlineMs?: number;
  /** Most body bytes kept, counted after decoding when `decompress` is set. */
  maxBytes: number;
  /** A body past `maxBytes` is an error, or is cut there with `truncated` set. */
  overflow: "error" | "truncate";
  /** Decode gzip, deflate and br bodies. The caller must then send a matching Accept-Encoding. */
  decompress?: boolean;
  /**
   * Sees the status and headers before the body is read. Throw to fail the
   * request; return false to take the response without reading its body.
   */
  inspect?: (status: number, headers: IncomingHttpHeaders) => void | false;
  /** Starts limit and timeout messages, e.g. "Agent fetch". */
  label: string;
  /** Drops the request when it fires, whether or not an answer has started; the promise then rejects. */
  signal?: AbortSignal;
}

export interface PinnedResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  truncated: boolean;
}

/**
 * One GET to a validated target, connected to the address that passed
 * validation. Redirects are not followed: a 3xx comes back as a response, and
 * the caller decides whether to validate its Location and ask again.
 */
export function requestValidated(target: ValidatedFetchTarget, options: PinnedRequestOptions): Promise<PinnedResponse> {
  const client = target.url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    let deadline: NodeJS.Timeout | undefined;
    const settle = <T>(finish: (value: T) => void) => (value: T) => {
      if (deadline) clearTimeout(deadline);
      finish(value);
    };
    const succeed = settle(resolve);
    const fail = settle(reject);

    const request = client.request(
      {
        protocol: target.url.protocol,
        hostname: target.url.hostname,
        port: target.url.port || undefined,
        method: "GET",
        path: `${target.url.pathname}${target.url.search}`,
        headers: options.headers,
        servername: target.url.hostname,
        signal: options.signal,
        // Pin the connection to the validated address. Node asks for a list
        // (`all`) when it may try several addresses, and a single one otherwise.
        lookup: (_hostname, lookupOptions, callback) => {
          if (lookupOptions.all) callback(null, [{ address: target.resolvedAddress, family: target.family }]);
          else callback(null, target.resolvedAddress, target.family);
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        let wantBody: void | false;
        try {
          wantBody = options.inspect?.(status, response.headers);
        } catch (error) {
          response.resume();
          fail(error);
          return;
        }
        if (wantBody === false) {
          response.resume();
          succeed({ status, headers: response.headers, body: Buffer.alloc(0), truncated: false });
          return;
        }

        let source: Readable = response;
        if (options.decompress) {
          const encoding = String(response.headers["content-encoding"] ?? "").trim().toLowerCase();
          const decoder =
            encoding === "gzip" || encoding === "x-gzip"
              ? zlib.createGunzip()
              : encoding === "deflate"
                ? zlib.createInflate()
                : encoding === "br"
                  ? zlib.createBrotliDecompress()
                  : undefined;
          if (decoder) {
            response.on("error", fail);
            source = response.pipe(decoder);
          }
        }

        const chunks: Buffer[] = [];
        let totalBytes = 0;

        source.on("data", (chunk: Buffer) => {
          totalBytes += chunk.length;
          if (totalBytes <= options.maxBytes) {
            chunks.push(chunk);
            return;
          }
          if (options.overflow === "error") {
            fail(new Error(`${options.label} exceeded ${options.maxBytes} bytes`));
          } else {
            chunks.push(chunk.subarray(0, chunk.length - (totalBytes - options.maxBytes)));
            succeed({ status, headers: response.headers, body: Buffer.concat(chunks), truncated: true });
          }
          request.destroy();
        });

        source.on("end", () => {
          succeed({ status, headers: response.headers, body: Buffer.concat(chunks), truncated: false });
        });

        source.on("error", fail);
      }
    );

    request.setTimeout(options.timeoutMs, () => {
      request.destroy(new Error(`${options.label} timed out after ${options.timeoutMs}ms`));
    });
    if (options.deadlineMs !== undefined) {
      deadline = setTimeout(() => {
        request.destroy(new Error(`${options.label} took longer than ${options.deadlineMs}ms`));
      }, options.deadlineMs);
    }
    request.on("error", fail);
    request.end();
  });
}
