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
  /** Base URL the document gives for this operation alone, when it differs from the upstream's. */
  server?: string;
  pathParams: string[];
  queryParams: string[];
  /** Body properties lifted to top-level arguments, or undefined when the body is passed as `body`. */
  bodyFields?: string[];
  hasBody: boolean;
}

const METHODS = ["get", "post", "put", "patch", "delete"] as const;
const SPEC_TTL_MS = 60 * 60_000;
const REQUEST_TIMEOUT_MS = 5 * 60_000;
const DESCRIPTION_LIMIT = 2000;
const REF_DEPTH_LIMIT = 12;

const specCache = new Map<string, { at: number; operations: Operation[] }>();

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

/** An absolute server URL declared on a path or operation, which overrides the document's default. */
function serverOf(node: Json | undefined): string | undefined {
  const url = ((node?.servers as Json[] | undefined)?.[0]?.url as string | undefined) ?? undefined;
  return typeof url === "string" && /^https?:\/\//.test(url) ? url : undefined;
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
      const params = [...((item.parameters as unknown[]) ?? []), ...((raw.parameters as unknown[]) ?? [])];
      for (const entry of params) {
        const param = deref(entry, spec) as Json;
        const name = param.name;
        if (typeof name !== "string" || (param.in !== "path" && param.in !== "query")) continue;
        const schema = { ...((param.schema as Json) ?? { type: "string" }) };
        if (typeof param.description === "string" && schema.description === undefined) schema.description = param.description;
        properties[name] = schema;
        if (param.in === "path") {
          pathParams.push(name);
          required.push(name);
        } else {
          queryParams.push(name);
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

/** Operations of every document, in order; a later document's duplicate method and path is dropped. */
async function loadOperations(locations: string[]): Promise<Operation[]> {
  const cacheKey = locations.join("\n");
  const cached = specCache.get(cacheKey);
  if (cached && Date.now() - cached.at < SPEC_TTL_MS) return cached.operations;
  const taken = new Set<string>();
  const seen = new Set<string>();
  const operations: Operation[] = [];
  for (const spec of await Promise.all(locations.map(loadSpec))) {
    for (const operation of operationsFromSpec(spec, taken)) {
      const id = `${operation.method} ${operation.server ?? ""}${operation.path}`;
      if (seen.has(id)) continue;
      seen.add(id);
      operations.push(operation);
    }
  }
  specCache.set(cacheKey, { at: Date.now(), operations });
  return operations;
}

/**
 * Connect to an upstream by its OpenAPI document: every operation becomes a
 * tool whose arguments are the operation's path, query and body parameters,
 * and a call is one HTTP request with the key in the configured header or
 * query parameter. A non-2xx response comes back as an error result that
 * starts with the status code.
 */
export async function connectOpenApi(upstream: UpstreamConfig, keyValue: string): Promise<UpstreamClient> {
  const operations = await loadOperations(upstream.specs);
  const byName = new Map(operations.map((operation) => [operation.tool.name, operation]));

  return {
    listTools: async () => ({ tools: operations.map((operation) => operation.tool) }),
    close: async () => undefined,
    callTool: async ({ name, arguments: args = {} }): Promise<CallToolResult> => {
      const operation = byName.get(name);
      if (!operation) {
        return { content: [{ type: "text", text: `${upstream.name} has no operation named "${name}".` }], isError: true };
      }

      let path = operation.path;
      for (const param of operation.pathParams) {
        const value = args[param];
        if (value === undefined || value === null) {
          return { content: [{ type: "text", text: `Missing path parameter "${param}".` }], isError: true };
        }
        path = path.replace(`{${param}}`, encodeURIComponent(String(value)));
      }
      const url = new URL((operation.server ?? upstream.url).replace(/\/+$/, "") + path);
      for (const param of operation.queryParams) {
        const value = args[param];
        if (value === undefined || value === null) continue;
        for (const item of Array.isArray(value) ? value : [value]) {
          url.searchParams.append(param, typeof item === "object" ? JSON.stringify(item) : String(item));
        }
      }

      const headers: Record<string, string> = { Accept: "application/json", "User-Agent": APP_USER_AGENT, ...upstream.headers };
      if (upstream.auth === "header" && keyValue) headers[upstream.authName] = `${upstream.authPrefix}${keyValue}`;
      if (upstream.auth === "query" && keyValue) url.searchParams.set(upstream.authName, keyValue);

      let body: string | undefined;
      if (operation.hasBody) {
        const payload = operation.bodyFields
          ? Object.fromEntries(Object.entries(args).filter(([key]) => !operation.pathParams.includes(key) && !operation.queryParams.includes(key)))
          : args.body;
        body = JSON.stringify(payload ?? {});
        headers["Content-Type"] = "application/json";
      }

      const response = await fetch(url, {
        method: operation.method.toUpperCase(),
        headers,
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const text = await response.text();
      if (!response.ok) {
        return { content: [{ type: "text", text: `HTTP ${response.status}: ${text.slice(0, 4000)}` }], isError: true };
      }
      return { content: [{ type: "text", text }] };
    },
  };
}
