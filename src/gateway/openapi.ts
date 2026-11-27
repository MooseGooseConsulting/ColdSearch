import { readFile } from "node:fs/promises";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { parse as parseYaml } from "yaml";
import { APP_USER_AGENT } from "../app.js";
import type { UpstreamConfig } from "./config.js";
import type { UpstreamClient } from "./core.js";

type Json = Record<string, unknown>;

interface Operation {
  tool: Tool;
  method: string;
  path: string;
  /** Absolute base URL declared on the operation, or else on its path. */
  server?: string;
  pathParams: string[];
  queryParams: string[];
  /** `in: header` parameters, by the header name the document gives. */
  headerParams: string[];
  /** Body properties lifted to top-level arguments, or undefined when the body is passed as `body`. */
  bodyFields?: string[];
  hasBody: boolean;
}

const METHODS = ["get", "post", "put", "patch", "delete"] as const;
const SPEC_TTL_MS = 60 * 60_000;
const REQUEST_TIMEOUT_MS = 5 * 60_000;
const DESCRIPTION_LIMIT = 2000;
const REF_DEPTH_LIMIT = 12;

/** An operation with the base URL its calls go to, after the precedence in `loadOperations`. */
interface ResolvedOperation extends Operation {
  base: string;
}

const specCache = new Map<string, { at: number; operations: ResolvedOperation[] }>();

/**
 * Replace local `$ref`s with what they point to. A reference that recurses,
 * or nests deeper than any real request needs, becomes an open object so the
 * schema stays finite.
 */
function deref(node: unknown, root: Json, seen: string[] = []): unknown {
  if (Array.isArray(node)) return node.map((item) => deref(item, root, seen));
  if (!node || typeof node !== "object") return node;
  const record = node as Json;
  const ref = record.$ref;
  if (typeof ref === "string") {
    if (!ref.startsWith("#/") || seen.includes(ref) || seen.length >= REF_DEPTH_LIMIT) return {};
    let target: unknown = root;
    for (const part of ref.slice(2).split("/")) {
      target = (target as Json | undefined)?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
    }
    return deref(target ?? {}, root, [...seen, ref]);
  }
  const out: Json = {};
  for (const [key, value] of Object.entries(record)) out[key] = deref(value, root, seen);
  return out;
}

function toolName(method: string, path: string, operationId: unknown, taken: Set<string>): string {
  const slug = (text: string) => text.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  // Generated ids (FastAPI's `search_v1_search_post`) repeat the path and end
  // in the method; for those, and for any id past 32 characters, the method
  // and path read better and stay unique.
  const id = typeof operationId === "string" ? slug(operationId) : "";
  const generated = id.toLowerCase().endsWith(`_${method}`);
  let base = id && !generated && id.length <= 32 ? id : `${method}_${slug(path)}`;
  base = base.slice(0, 48) || `${method}_root`;
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base.slice(0, 45)}_${n}`;
  taken.add(name);
  return name;
}

/**
 * The first `servers` URL declared on a document, path or operation, when it
 * is usable as it stands: absolute, with no `{variable}` left to fill in.
 */
function serverOf(node: Json | undefined): string | undefined {
  const url = ((node?.servers as Json[] | undefined)?.[0]?.url as string | undefined) ?? undefined;
  return typeof url === "string" && /^https?:\/\/[^{}]+$/.test(url) ? url : undefined;
}

/** A base URL in one spelling, so two documents naming the same host compare equal. */
function baseOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "");
  } catch {
    return url.replace(/\/+$/, "");
  }
}

/** Turn every operation in an OpenAPI document into a tool definition. */
export function operationsFromSpec(spec: Json, taken: Set<string> = new Set()): Operation[] {
  const operations: Operation[] = [];
  const paths = (spec.paths ?? {}) as Record<string, Json>;

  for (const [path, item] of Object.entries(paths)) {
    for (const method of METHODS) {
      const raw = item?.[method] as Json | undefined;
      if (!raw) continue;

      const properties: Json = {};
      const required: string[] = [];
      const pathParams: string[] = [];
      const queryParams: string[] = [];
      const headerParams: string[] = [];
      const params = [...((item.parameters as unknown[]) ?? []), ...((raw.parameters as unknown[]) ?? [])];
      for (const entry of params) {
        const param = deref(entry, spec) as Json;
        const name = param.name;
        if (typeof name !== "string" || (param.in !== "path" && param.in !== "query" && param.in !== "header")) continue;
        const schema = { ...((param.schema as Json) ?? { type: "string" }) };
        if (typeof param.description === "string" && schema.description === undefined) schema.description = param.description;
        properties[name] = schema;
        if (param.in === "path") {
          pathParams.push(name);
          required.push(name);
        } else {
          (param.in === "header" ? headerParams : queryParams).push(name);
          if (param.required === true) required.push(name);
        }
      }

      const content = (deref(raw.requestBody, spec) as Json | undefined)?.content as Json | undefined;
      const bodySchema = (content?.["application/json"] as Json | undefined)?.schema as Json | undefined;
      let bodyFields: string[] | undefined;
      if (bodySchema) {
        const bodyProps = bodySchema.properties as Json | undefined;
        const liftable =
          bodySchema.type === "object" && bodyProps && !Object.keys(bodyProps).some((key) => key in properties);
        if (liftable) {
          bodyFields = Object.keys(bodyProps);
          Object.assign(properties, bodyProps);
          for (const key of (bodySchema.required as string[] | undefined) ?? []) required.push(key);
        } else {
          properties.body = bodySchema;
          required.push("body");
        }
      }

      const summary = typeof raw.summary === "string" ? raw.summary.trim() : "";
      const detail = typeof raw.description === "string" ? raw.description.trim() : "";
      const description = `${method.toUpperCase()} ${path}${summary ? ` — ${summary}` : ""}${detail && detail !== summary ? `\n${detail}` : ""}`;

      operations.push({
        tool: {
          name: toolName(method, path, raw.operationId, taken),
          description: description.slice(0, DESCRIPTION_LIMIT),
          inputSchema: { type: "object", properties: properties as Record<string, object>, ...(required.length ? { required: [...new Set(required)] } : {}) },
          annotations: { readOnlyHint: method === "get" },
        },
        method,
        path,
        server: serverOf(raw) ?? serverOf(item),
        pathParams,
        queryParams,
        headerParams,
        bodyFields,
        hasBody: Boolean(bodySchema),
      });
    }
  }
  return operations;
}

async function loadSpec(location: string): Promise<Json> {
  let text: string;
  if (/^https?:\/\//.test(location)) {
    const response = await fetch(location, { headers: { "User-Agent": APP_USER_AGENT }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`could not fetch API spec ${location}: HTTP ${response.status}`);
    text = await response.text();
  } else {
    text = await readFile(location, "utf8");
  }
  const spec = (text.trimStart().startsWith("{") ? JSON.parse(text) : parseYaml(text)) as Json;
  if (!spec || typeof spec !== "object" || !spec.paths) throw new Error(`API spec ${location} has no paths`);
  return spec;
}

/**
 * Operations of every document, in order, each with the base URL its calls
 * go to. Precedence: a server on the operation, then on its path, then the
 * document's own server when the upstream lists more than one document, then
 * the upstream's `url`. With a single document the upstream's `url` outranks
 * the document's server, which is how a config points at a regional or
 * self-hosted base. A later operation with the same method, base URL and
 * path as an earlier one is dropped; the same path on two hosts is kept twice.
 */
async function loadOperations(locations: string[], url: string): Promise<ResolvedOperation[]> {
  const cacheKey = [url, ...locations].join("\n");
  const cached = specCache.get(cacheKey);
  if (cached && Date.now() - cached.at < SPEC_TTL_MS) return cached.operations;
  const taken = new Set<string>();
  const seen = new Set<string>();
  const operations: ResolvedOperation[] = [];
  for (const spec of await Promise.all(locations.map(loadSpec))) {
    const documentServer = locations.length > 1 ? serverOf(spec) : undefined;
    for (const operation of operationsFromSpec(spec, taken)) {
      const base = baseOf(operation.server ?? documentServer ?? url);
      const id = `${operation.method} ${base}${operation.path}`;
      if (seen.has(id)) continue;
      seen.add(id);
      operations.push({ ...operation, base });
    }
  }
  specCache.set(cacheKey, { at: Date.now(), operations });
  return operations;
}

/** Headers the gateway writes itself on every request, whatever the document declares. */
const TRANSPORT_HEADERS = new Set(["content-type", "content-length", "host", "connection", "transfer-encoding"]);

/**
 * Why a tool argument may not set this request header, or undefined when it
 * may. Credentials and the headers a config fixes belong to the operator.
 */
function reservedHeader(name: string, upstream: UpstreamConfig): string | undefined {
  const lower = name.toLowerCase();
  if (upstream.auth === "header" && lower === upstream.authName.toLowerCase()) {
    return `it carries ${upstream.name}'s key, which the gateway supplies`;
  }
  if (lower === "authorization" || lower === "proxy-authorization") {
    return "credentials come from the gateway's key list, never from tool arguments";
  }
  if (Object.keys(upstream.headers).some((key) => key.toLowerCase() === lower)) {
    return `the gateway's config fixes it for every ${upstream.name} request`;
  }
  if (TRANSPORT_HEADERS.has(lower)) return "the gateway sets it for every request";
  return undefined;
}

/** The tool as agents see it: without the arguments that would set a reserved header. */
function withoutArguments(tool: Tool, names: string[]): Tool {
  if (names.length === 0) return tool;
  const schema = tool.inputSchema;
  const properties = Object.fromEntries(Object.entries(schema.properties ?? {}).filter(([key]) => !names.includes(key)));
  const required = (schema.required ?? []).filter((key) => !names.includes(key));
  const { required: _dropped, ...rest } = schema;
  return { ...tool, inputSchema: { ...rest, properties, ...(required.length ? { required } : {}) } };
}

function errorText(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** One server-sent event. `id` is present when the upstream sent one, so a cut-short stream can be resumed. */
interface StreamEvent {
  event: string;
  data: unknown;
  id?: string;
}

/**
 * Parse one event block. `data` lines are joined and parsed as JSON when they
 * parse; an event without `event:` is a "message". A block with neither a
 * name nor data (a comment or keep-alive) yields nothing.
 */
function parseEvent(block: string): StreamEvent | undefined {
  let event: string | undefined;
  let id: string | undefined;
  const data: string[] = [];
  for (const line of block.split(/\r\n|\r|\n/)) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "id") id = value;
  }
  if (event === undefined && data.length === 0) return undefined;
  let parsed: unknown = data.length ? data.join("\n") : null;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      // Not JSON (plain text, or a marker such as "[DONE]"): keep the text.
    }
  }
  return { event: event ?? "message", data: parsed, ...(id !== undefined ? { id } : {}) };
}

/**
 * Read an event stream until the upstream closes it, `deadline` (epoch ms)
 * passes, or `maxBytes` have arrived. Returns the complete events received;
 * `cut` says what stopped the read early, and an event still arriving at
 * that moment is left out.
 *
 * A connection that breaks partway is a `dropped` cut, with the transport's
 * message in `reason`, when at least one complete event arrived: those events
 * may hold the run id or event `id` the caller needs to poll or resume. A
 * stream that breaks before its first complete event throws.
 */
async function readEventStream(
  body: ReadableStream<Uint8Array>,
  deadline: number,
  maxBytes: number
): Promise<{ events: StreamEvent[]; cut?: "time" | "bytes" | "dropped"; reason?: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const events: StreamEvent[] = [];
  let buffer = "";
  let bytes = 0;
  let cut: "time" | "bytes" | "dropped" | undefined;
  let reason: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<"time">((resolve) => {
    timer = setTimeout(() => resolve("time"), Math.max(0, deadline - Date.now()));
  });
  try {
    while (!cut) {
      let next: Awaited<ReturnType<typeof reader.read>> | "time";
      try {
        next = await Promise.race([reader.read(), expired]);
      } catch (error) {
        if (events.length === 0) throw error;
        cut = "dropped";
        reason = (error as Error).message || String(error);
        break;
      }
      if (next === "time") {
        cut = "time";
        break;
      }
      if (next.done) break;
      let chunk = next.value;
      if (bytes + chunk.byteLength > maxBytes) {
        chunk = chunk.subarray(0, maxBytes - bytes);
        cut = "bytes";
      }
      bytes += chunk.byteLength;
      buffer += decoder.decode(chunk, { stream: true });
      const blocks = buffer.split(/\r\n\r\n|\n\n|\r\r/);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const event = parseEvent(block);
        if (event) events.push(event);
      }
    }
    if (!cut) {
      // The stream ended; a last event need not be followed by a blank line.
      const event = parseEvent(buffer + decoder.decode());
      if (event) events.push(event);
    }
  } finally {
    clearTimeout(timer);
    if (cut) await reader.cancel().catch(() => undefined);
  }
  return { events, cut, reason };
}

const TEXT_TYPE = /^text\/|[/+](?:json|xml)$|^application\/(?:x-ndjson|jsonl|javascript|yaml|x-yaml|x-www-form-urlencoded)$/;
const BINARY_TYPE = /^(?:image|audio|video|font)\/|^application\/(?:pdf|zip|gzip|x-gzip)$/;

/** The response's media type without parameters, lower-cased; "" when it names none. */
function mediaType(response: Response): string {
  return (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
}

/**
 * Read a response body that is not an event stream. Text comes back as
 * text. A body declared as an image, audio, video, font, PDF or archive, or
 * one of an undeclared or unknown type that is not valid UTF-8 text, is
 * counted and dropped: `binary` then holds its size in bytes.
 */
async function readBody(response: Response): Promise<{ text: string } | { binary: number }> {
  const type = mediaType(response);
  if (BINARY_TYPE.test(type) && !TEXT_TYPE.test(type)) {
    let size = 0;
    if (response.body) {
      for await (const chunk of response.body) size += (chunk as Uint8Array).byteLength;
    }
    return { binary: size };
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (TEXT_TYPE.test(type)) return { text: bytes.toString("utf8") };
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.includes("\u0000") ? { binary: bytes.byteLength } : { text };
  } catch {
    return { binary: bytes.byteLength };
  }
}

function binaryNotice(type: string, size: number): string {
  return `The response body is ${type || "binary with no declared content type"}, ${size} bytes. The gateway does not pass binary bodies through, so it was dropped. If this operation can answer with a URL, base64 inside JSON or a text format, ask for that.`;
}

/**
 * Connect to an upstream by its OpenAPI documents: every operation becomes a
 * tool whose arguments are the operation's path, query, header and body
 * parameters, and a call is one HTTP request with the key in the configured
 * header or query parameter.
 *
 * - A header parameter is sent when the agent supplies it. One that would set
 *   the key's header, `Authorization`, a header the config fixes, or a header
 *   the gateway writes itself is not offered, and a call that supplies it is
 *   refused before any request is made.
 * - A `text/event-stream` response is read to its end, or to the upstream's
 *   `streamTimeoutMs` (counted from when the request was sent) or
 *   `streamMaxBytes`, and returned as a JSON array of `{event, data}`. A
 *   second text item says so when a limit, or a connection that broke after
 *   at least one event, cut it short.
 * - A binary response is not returned: the result names its content type and
 *   size.
 * - A non-2xx response comes back as an error result that starts with
 *   `HTTP <status>:` and ends with the `x-brd-err-code` response header when
 *   the upstream sent one.
 */
export async function connectOpenApi(upstream: UpstreamConfig, keyValue: string): Promise<UpstreamClient> {
  const operations = await loadOperations(upstream.specs, upstream.url);
  const byName = new Map(operations.map((operation) => [operation.tool.name, operation]));
  const reserved = (operation: Operation) => operation.headerParams.filter((name) => reservedHeader(name, upstream));
  const tools = operations.map((operation) => withoutArguments(operation.tool, reserved(operation)));

  return {
    listTools: async () => ({ tools }),
    close: async () => undefined,
    callTool: async ({ name, arguments: args = {} }): Promise<CallToolResult> => {
      const operation = byName.get(name);
      if (!operation) return errorText(`${upstream.name} has no operation named "${name}".`);

      let path = operation.path;
      for (const param of operation.pathParams) {
        const value = args[param];
        if (value === undefined || value === null) return errorText(`Missing path parameter "${param}".`);
        path = path.replace(`{${param}}`, encodeURIComponent(String(value)));
      }
      const url = new URL(operation.base + path);
      for (const param of operation.queryParams) {
        const value = args[param];
        if (value === undefined || value === null) continue;
        for (const item of Array.isArray(value) ? value : [value]) {
          url.searchParams.append(param, typeof item === "object" ? JSON.stringify(item) : String(item));
        }
      }

      const headers = new Headers({ Accept: "application/json", "User-Agent": APP_USER_AGENT });
      for (const param of operation.headerParams) {
        const value = args[param];
        if (value === undefined || value === null) continue;
        const reason = reservedHeader(param, upstream);
        if (reason) {
          return errorText(`Argument "${param}" is refused: it would set the ${param} request header, and ${reason}. Leave it out.`);
        }
        try {
          headers.set(param, Array.isArray(value) ? value.join(",") : typeof value === "object" ? JSON.stringify(value) : String(value));
        } catch {
          return errorText(`Argument "${param}" is sent as a request header and its value is not valid in one (no line breaks or control characters).`);
        }
      }
      for (const [key, value] of Object.entries(upstream.headers)) headers.set(key, value);
      if (upstream.auth === "header" && keyValue) headers.set(upstream.authName, `${upstream.authPrefix}${keyValue}`);
      if (upstream.auth === "query" && keyValue) url.searchParams.set(upstream.authName, keyValue);

      let body: string | undefined;
      if (operation.hasBody) {
        const elsewhere = [...operation.pathParams, ...operation.queryParams, ...operation.headerParams];
        const payload = operation.bodyFields
          ? Object.fromEntries(Object.entries(args).filter(([key]) => !elsewhere.includes(key)))
          : args.body;
        body = JSON.stringify(payload ?? {});
        headers.set("Content-Type", "application/json");
      }

      // The request limit covers the wait for a response and a plain body. A
      // stream is released from it and read under the stream limits instead.
      const sent = Date.now();
      const abort = new AbortController();
      const requestTimer = setTimeout(
        () => abort.abort(new DOMException(`no complete response within ${REQUEST_TIMEOUT_MS / 1000} s`, "TimeoutError")),
        REQUEST_TIMEOUT_MS
      );
      try {
        const response = await fetch(url, { method: operation.method.toUpperCase(), headers, body, signal: abort.signal });

        if (response.ok && response.body && mediaType(response) === "text/event-stream") {
          clearTimeout(requestTimer);
          const { events, cut, reason } = await readEventStream(response.body, sent + upstream.streamTimeoutMs, upstream.streamMaxBytes);
          const content: CallToolResult["content"] = [{ type: "text", text: JSON.stringify(events) }];
          if (cut) {
            const arrived = `The ${events.length} event${events.length === 1 ? "" : "s"} above arrived before that`;
            const notice =
              cut === "time"
                ? `the gateway reads a stream for at most ${upstream.streamTimeoutMs / 1000} s (stream_timeout). ${arrived}; the upstream had more to send.`
                : cut === "bytes"
                  ? `the gateway reads at most ${upstream.streamMaxBytes} bytes of a stream (stream_max_bytes). ${arrived}; the upstream had more to send.`
                  : `the connection broke before the upstream ended the stream (${reason}). ${arrived}; what the upstream sent after them, if anything, is lost.`;
            content.push({ type: "text", text: `Stream cut short: ${notice}` });
          }
          return { content };
        }

        const read = await readBody(response);
        const text = "text" in read ? read.text : binaryNotice(mediaType(response), read.binary);
        if (!response.ok) {
          const vendorCode = response.headers.get("x-brd-err-code");
          const suffix = vendorCode ? ` [x-brd-err-code: ${vendorCode.slice(0, 100)}]` : "";
          return errorText(`HTTP ${response.status}: ${text.slice(0, 4000)}${suffix}`);
        }
        return { content: [{ type: "text", text }] };
      } finally {
        clearTimeout(requestTimer);
      }
    },
  };
}
