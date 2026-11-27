import type { IncomingMessage, ServerResponse } from "node:http";
import type { KeysConfig } from "../keys/config.js";
import { rotateSlot } from "../keys/rotate.js";
import { collectKeyStatus, type KeysDeps } from "../keys/status.js";
import { durationMs } from "./config.js";
import type { GatewayCore } from "./core.js";
import { DASHBOARD_CSP, DASHBOARD_HTML } from "./dashboard.js";
import { redact } from "./ledger.js";

/** What the dashboard and its JSON endpoints may show and do, beyond the gateway itself. */
export interface GatewayApiOptions {
  /** The config's `[keys]` section, resolved. Undefined when it has none: the key endpoints then answer 404. */
  keys?: KeysConfig;
  /** Whether `POST /api/keys/rotate` is enabled. Off unless the operator asked for it. */
  allowRotate?: boolean;
  /** How secrets are reached; tests supply a stand-in. */
  keysDeps?: KeysDeps;
  /** Where one operator line per rotation request goes. Default: stderr. */
  note?: (message: string) => void;
}

/** Request header a rotation must carry, with the value `rotate`. */
export const ROTATE_CONFIRM_HEADER = "x-coldsearch-confirm";
/** Response header on `GET /api/keys`: `enabled` or `disabled`, so a client knows whether rotation is offered. */
export const ROTATE_STATE_HEADER = "X-Coldsearch-Rotate";

const DEFAULT_SINCE = "24h";
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const MAX_BODY_BYTES = 4096;

/** A request the API refuses; `message` is sent to the client as `{"error": message}`. */
class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { ...JSON_HEADERS, ...headers });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function requireMethod(req: IncomingMessage, method: "GET" | "POST", path: string): void {
  if (req.method !== method) throw new ApiError(405, `${path} takes ${method} only`);
}

/** Read a small JSON request body. Refuses a body that is not JSON, not an object, or over 4 KB. */
async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) {
    throw new ApiError(415, "Send the body as Content-Type: application/json");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new ApiError(413, `The request body is over ${MAX_BODY_BYTES} bytes`);
    chunks.push(chunk);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "The request body is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApiError(400, "The request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/** HTTP status for an error thrown by `src/keys`, by the category it carries; undefined for any other error. */
function keysErrorStatus(error: unknown): number | undefined {
  switch ((error as { category?: string }).category) {
    case "validation":
      return 400;
    case "config":
      return 404;
    case "credentials":
      return 502;
    default:
      return undefined;
  }
}

/**
 * Serve `GET /dashboard`: the page shell. It holds no data and no token, so
 * it is served without one; everything it shows comes from `/api/*` calls
 * the page makes with the token the operator types in.
 */
export function serveDashboard(req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, 405, { error: "/dashboard takes GET only" });
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": DASHBOARD_CSP,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(req.method === "HEAD" ? undefined : DASHBOARD_HTML);
}

/**
 * The gateway's JSON endpoints under `/api/`. The caller has already checked
 * the bearer token. The returned handler answers with the data, or with
 * `{"error": "..."}` and a status that says whose fault it was; an error it
 * does not recognise is thrown for the server to report as a 500. No response
 * carries a key value: key data passes through redaction against every value
 * read while producing it, as the `keys` commands do.
 */
export function createGatewayApi(
  core: GatewayCore,
  options: GatewayApiOptions = {}
): (req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams) => Promise<void> {
  const note = options.note ?? ((message: string) => process.stderr.write(`coldsearch gateway: ${message}\n`));
  /** Providers with a rotation in flight: a second request must not race the first one's read-then-write. */
  const rotating = new Set<string>();

  const status = (req: IncomingMessage, res: ServerResponse): void => {
    requireMethod(req, "GET", "/api/status");
    sendJson(res, 200, core.status());
  };

  const ledger = async (req: IncomingMessage, res: ServerResponse, query: URLSearchParams): Promise<void> => {
    requireMethod(req, "GET", "/api/ledger");
    const since = query.get("since") ?? DEFAULT_SINCE;
    const sinceMs = durationMs(since);
    if (sinceMs === undefined) throw new ApiError(400, 'since must be a duration such as "90s", "30m", "24h" or "7d"');

    const limitText = query.get("limit");
    const limit = limitText === null ? DEFAULT_LIMIT : Number(limitText);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new ApiError(400, `limit must be a whole number from 1 to ${MAX_LIMIT}`);
    }
    const upstream = query.get("upstream") || undefined;

    let page;
    try {
      page = await core.ledger.recent({ sinceMs, upstream, limit });
    } catch (error) {
      throw new ApiError(500, (error as Error).message);
    }
    sendJson(res, 200, { since, upstream: upstream ?? null, limit, matched: page.matched, entries: page.entries });
  };

  const requireKeys = (): KeysConfig => {
    if (!options.keys) {
      throw new ApiError(
        404,
        "This gateway's config has no [keys] section, so there are no key pools to show or rotate (see docs/components/keys.md)"
      );
    }
    return options.keys;
  };

  const keys = async (req: IncomingMessage, res: ServerResponse, query: URLSearchParams): Promise<void> => {
    requireMethod(req, "GET", "/api/keys");
    const config = requireKeys();
    const { report, secrets } = await collectKeyStatus(config, query.get("provider") || undefined, options.keysDeps);
    sendJson(res, 200, redact(JSON.stringify(report), secrets), {
      [ROTATE_STATE_HEADER]: options.allowRotate ? "enabled" : "disabled",
    });
  };

  const rotate = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    requireMethod(req, "POST", "/api/keys/rotate");
    if (!options.allowRotate) {
      throw new ApiError(403, "Rotation over HTTP is disabled: this gateway was started without --allow-rotate");
    }
    if (req.headers[ROTATE_CONFIRM_HEADER] !== "rotate") {
      throw new ApiError(403, 'This request changes a secret: confirm it with the header "X-Coldsearch-Confirm: rotate"');
    }
    const config = requireKeys();

    const body = await readJsonObject(req);
    for (const field of Object.keys(body)) {
      if (field !== "provider" && field !== "to" && field !== "dry_run") {
        throw new ApiError(400, `Unknown field "${field.slice(0, 40)}"; the body takes provider, to and dry_run`);
      }
    }
    if (typeof body.provider !== "string" || !body.provider) throw new ApiError(400, "provider must be the name of a [keys.<provider>] block");
    if (body.to !== undefined && typeof body.to !== "string") throw new ApiError(400, "to must be a pool secret name");
    if (body.dry_run !== undefined && typeof body.dry_run !== "boolean") throw new ApiError(400, "dry_run must be true or false");
    const dryRun = body.dry_run === true;

    const provider = config.providers.find((item) => item.provider === body.provider);
    if (!provider) {
      throw new ApiError(
        404,
        `No [keys.${body.provider.slice(0, 40)}] block in the config; configured: ${config.providers.map((item) => item.provider).join(", ")}`
      );
    }
    if (rotating.has(provider.provider)) {
      throw new ApiError(409, `A rotation of ${provider.provider} is already running; try again when it has finished`);
    }

    rotating.add(provider.provider);
    try {
      const result = await rotateSlot(provider, { to: body.to as string | undefined, dryRun }, options.keysDeps);
      const answer = {
        provider: result.provider,
        slot: result.slot,
        outcome: result.outcome,
        before: result.was,
        after: result.outcome === "refused" ? null : result.target,
        reason: result.why,
        dry_run: dryRun,
      };
      note(redact(`rotate ${result.provider} over HTTP: ${result.outcome} (${result.was} -> ${answer.after ?? "no change"})`, result.secrets));
      sendJson(res, result.outcome === "refused" ? 409 : 200, redact(JSON.stringify(answer), result.secrets));
    } catch (error) {
      note(`rotate ${provider.provider} over HTTP: failed (${(error as Error).message})`);
      throw error;
    } finally {
      rotating.delete(provider.provider);
    }
  };

  return async (req, res, path, query) => {
    try {
      switch (path) {
        case "/api/status":
          status(req, res);
          return;
        case "/api/ledger":
          await ledger(req, res, query);
          return;
        case "/api/keys":
          await keys(req, res, query);
          return;
        case "/api/keys/rotate":
          await rotate(req, res);
          return;
        default:
          throw new ApiError(404, "Not found; the API has /api/status, /api/ledger, /api/keys and /api/keys/rotate");
      }
    } catch (error) {
      const code = error instanceof ApiError ? error.status : keysErrorStatus(error);
      if (code === undefined) throw error;
      sendJson(res, code, { error: (error as Error).message });
    }
  };
}
