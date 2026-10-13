import type { Config } from "../types.js";

export interface BrightDataToolRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  useTextParser: boolean;
  /** Per-request HTTP timeout in ms; omitted means the substrate default. */
  timeoutMs?: number;
  /**
   * Masked zone suffix (after the last `-`) for usage-log attribution. Never
   * the full zone — zone names embed the Bright Data customer ID.
   */
  maskedZone?: string;
}

function configuredString(
  config: Config,
  key: string,
  envName?: string
): string | undefined {
  const value = config.providers.brightdata?.options?.[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (envName) {
    const envValue = process.env[envName];
    if (envValue?.trim()) return envValue.trim();
  }
  return undefined;
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const integer = Math.floor(value);
    return integer > 0 ? integer : undefined;
  }
  if (typeof value === "string" && /^\d+$/.test(value) && Number(value) > 0) {
    return Number(value);
  }
  return undefined;
}

function configuredPositiveInteger(config: Config, key: string, fallback: number): number {
  const value = positiveInteger(config.providers.brightdata?.options?.[key]);
  return value ?? fallback;
}

function requireValue(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Bright Data ${name} is required`);
  }
  return value.trim();
}

function snapshotId(params: Record<string, any>): string {
  return requireValue(params.snapshot_id ?? params.snapshotId ?? params.id, "snapshot_id");
}

function requireZone(
  params: Record<string, any>,
  config: Config,
  optionKey: "serpZone" | "unlockerZone",
  envName: string
): string {
  const explicit = typeof params.zone === "string" ? params.zone.trim() : "";
  if (explicit) return explicit;
  const configured = configuredString(config, optionKey, envName);
  if (configured) return configured;
  throw new Error(
    `Bright Data requires params.zone, providers.brightdata.options.${optionKey}, or ${envName}`
  );
}

/**
 * Safe zone label for usage logs: zone names embed the Bright Data customer ID
 * (`brd-customer_<id>-zone-serp`), so only the suffix after the last `-` is
 * ever exposed. A zone without a `-` gets a constant placeholder.
 */
function maskZone(zone: string): string {
  const lastDash = zone.lastIndexOf("-");
  if (lastDash > 0 && lastDash < zone.length - 1) return zone.slice(lastDash + 1);
  return "configured";
}

/** Shared search-engine URL builder (used by the adapter and the serp mapper). */
export function searchUrlFromQuery(query: string, engine: string): string {
  const q = encodeURIComponent(query);
  switch (engine.toLowerCase()) {
    case "bing":
      return `https://www.bing.com/search?q=${q}`;
    case "duckduckgo":
    case "ddg":
      return `https://duckduckgo.com/?q=${q}`;
    case "google":
    default:
      return `https://www.google.com/search?q=${q}`;
  }
}

function inputsFromParams(params: Record<string, any>, config: Config): unknown[] {
  let inputs: unknown[];
  if (Array.isArray(params.inputs)) inputs = params.inputs;
  else if (Array.isArray(params.input)) inputs = params.input;
  else if (params.input && typeof params.input === "object") inputs = [params.input];
  else throw new Error("Bright Data scraper tool requires input or inputs");

  // Bright Data documents a maximum of 20 URLs/items for synchronous scraper
  // requests. Keep the same conservative default for structured calls; an
  // operator can raise it deliberately for async jobs after considering spend.
  const maxInputs = configuredPositiveInteger(config, "maxStructuredInputsPerCall", 20);
  if (inputs.length === 0) {
    throw new Error("Bright Data scraper tool requires at least one input record");
  }
  if (inputs.length > maxInputs) {
    throw new Error(
      `Bright Data structured request has ${inputs.length} inputs; configured maximum is ${maxInputs}. ` +
        "Increase providers.brightdata.options.maxStructuredInputsPerCall deliberately for larger paid runs."
    );
  }
  return inputs;
}

function appendNativeQueryParams(
  requestUrl: URL,
  params: Record<string, any>,
  excluded: ReadonlySet<string>
): void {
  for (const [key, value] of Object.entries(params)) {
    if (excluded.has(key) || value === undefined || value === null) continue;
    if (["string", "number", "boolean"].includes(typeof value)) {
      requestUrl.searchParams.set(key, String(value));
    }
  }
}

/**
 * Async trigger/crawl discovery jobs multiply `limit_per_input` across every
 * input record, so one request can launch a large paid run that defeats the
 * input cap. Reject a `limit_per_input` above the configured ceiling before
 * any request is built; the default matches the conservative style of
 * `maxStructuredInputsPerCall`.
 */
function assertDiscoveryLimit(params: Record<string, any>, config: Config): void {
  const rawLimit = params.limit_per_input;
  if (rawLimit === undefined || rawLimit === null) return;
  const limit =
    typeof rawLimit === "number" && Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.floor(rawLimit)
      : typeof rawLimit === "string" && /^\d+$/.test(rawLimit)
        ? Number(rawLimit)
        : 0;
  if (limit === 0) return;
  const maxDiscovery = configuredPositiveInteger(config, "maxDiscoveryResultsPerInput", 20);
  if (limit > maxDiscovery) {
    throw new Error(
      `Bright Data limit_per_input ${limit} exceeds configured maximum ${maxDiscovery}. ` +
        "Increase providers.brightdata.options.maxDiscoveryResultsPerInput deliberately for larger paid runs."
    );
  }
}

/** Build an authenticated provider-native Bright Data HTTP request. */
export function buildBrightDataToolRequest(
  tool: string,
  params: Record<string, any>,
  apiKey: string,
  config: Config
): BrightDataToolRequest {
  const baseUrl = "https://api.brightdata.com";
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
  };
  // Content-Type only applies when a JSON body is actually sent; bodyless GETs
  // (datasets list, metadata, progress, snapshot download, cancel) must not
  // claim a JSON request body.
  const jsonHeaders: Record<string, string> = {
    ...headers,
    "Content-Type": "application/json",
  };

  if (tool === "serp") {
    const zone = requireZone(params, config, "serpZone", "BRIGHTDATA_SERP_ZONE");
    const engine =
      typeof params.searchEngine === "string"
        ? params.searchEngine
        : configuredString(config, "searchEngine") || "google";
    const url =
      typeof params.url === "string" && params.url.trim()
        ? params.url.trim()
        : searchUrlFromQuery(requireValue(params.query ?? params.q, "query or url"), engine);
    const country =
      typeof params.country === "string"
        ? params.country
        : configuredString(config, "searchCountry") || "us";
    const format = params.format || "json";

    const payload: Record<string, any> = {
      ...params,
      zone,
      url,
      format,
      method: params.method || "GET",
      country,
    };
    delete payload.query;
    delete payload.q;
    delete payload.searchEngine;

    return {
      url: `${baseUrl}/request`,
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify(payload),
      // `format: "raw"` asks the API for HTML, not JSON; route any non-JSON
      // format through the text parser (mirrors the unlocker mapper).
      useTextParser: format !== "json",
      maskedZone: maskZone(zone),
    };
  }

  if (tool === "unlocker") {
    const zone = requireZone(params, config, "unlockerZone", "BRIGHTDATA_UNLOCKER_ZONE");
    const targetUrl = requireValue(params.url, "url");
    const format = typeof params.format === "string" ? params.format : "raw";
    // Screenshots come back as binary PNG, which cannot be recorded in
    // history/replay without corruption. Reject binary data formats up front.
    const dataFormat = typeof params.data_format === "string" ? params.data_format : "markdown";
    if (dataFormat === "screenshot") {
      throw new Error(
        "Bright Data unlocker data_format 'screenshot' returns binary PNG that cannot be recorded safely; " +
          "use a text format such as 'markdown' or 'html'"
      );
    }
    const payloadParams = { ...params };
    delete payloadParams.unlockerTimeoutMs;
    const payload = {
      ...payloadParams,
      zone,
      url: targetUrl,
      format,
      method: params.method || "GET",
      data_format: dataFormat,
    };
    // Any non-JSON format is a text/HTML payload and must not go through the
    // JSON response parser. The unlocker documents native `format: "html"`,
    // which would otherwise fail JSON parsing.
    const timeoutMs =
      positiveInteger(params.unlockerTimeoutMs) ??
      configuredPositiveInteger(config, "unlockerTimeoutMs", 0);

    return {
      url: `${baseUrl}/request`,
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify(payload),
      useTextParser: format !== "json",
      ...(timeoutMs > 0 ? { timeoutMs } : {}),
      maskedZone: maskZone(zone),
    };
  }

  if (tool === "datasetsList") {
    return {
      url: `${baseUrl}/datasets/list`,
      method: "GET",
      headers,
      body: null,
      useTextParser: false,
    };
  }

  if (tool === "datasetMetadata") {
    const datasetId = requireValue(params.dataset_id ?? params.datasetId, "dataset_id");
    return {
      url: `${baseUrl}/datasets/${encodeURIComponent(datasetId)}/metadata`,
      method: "GET",
      headers,
      body: null,
      useTextParser: false,
    };
  }

  if (tool === "scrape") {
    const datasetId = requireValue(params.dataset_id ?? params.datasetId, "dataset_id");
    const format = typeof params.format === "string" ? params.format : "json";
    const requestUrl = new URL(`${baseUrl}/datasets/v3/scrape`);
    requestUrl.searchParams.set("dataset_id", datasetId);
    requestUrl.searchParams.set("format", format);
    appendNativeQueryParams(
      requestUrl,
      params,
      new Set(["dataset_id", "datasetId", "input", "inputs", "format"])
    );

    return {
      url: requestUrl.toString(),
      method: "POST",
      headers: jsonHeaders,
      // The synchronous scrape API expects the input records under an `input`
      // key (`{"input": [...]}`); async trigger/crawl take a bare array.
      body: JSON.stringify({ input: inputsFromParams(params, config) }),
      useTextParser: format !== "json",
    };
  }

  if (tool === "trigger" || tool === "crawl") {
    const datasetId = requireValue(params.dataset_id ?? params.datasetId, "dataset_id");
    assertDiscoveryLimit(params, config);
    const requestUrl = new URL(`${baseUrl}/datasets/v3/trigger`);
    requestUrl.searchParams.set("dataset_id", datasetId);
    appendNativeQueryParams(
      requestUrl,
      params,
      new Set(["dataset_id", "datasetId", "input", "inputs"])
    );

    return {
      url: requestUrl.toString(),
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify(inputsFromParams(params, config)),
      useTextParser: false,
    };
  }

  if (tool === "progress") {
    return {
      url: `${baseUrl}/datasets/v3/progress/${encodeURIComponent(snapshotId(params))}`,
      method: "GET",
      headers,
      body: null,
      useTextParser: false,
    };
  }

  if (tool === "snapshotMetadata") {
    return {
      url: `${baseUrl}/datasets/snapshots/${encodeURIComponent(snapshotId(params))}`,
      method: "GET",
      headers,
      body: null,
      useTextParser: false,
    };
  }

  if (tool === "cancel") {
    return {
      url: `${baseUrl}/datasets/v3/snapshot/${encodeURIComponent(snapshotId(params))}/cancel`,
      method: "POST",
      headers,
      body: null,
      useTextParser: false,
    };
  }

  if (tool === "snapshot") {
    // Compressed downloads are binary and no parser can handle them; reject
    // up front so binary output never reaches history/replay (same pattern as
    // the unlocker screenshot rejection).
    if (params.compress === true || params.compress === "true") {
      throw new Error(
        "Bright Data snapshot compress produces binary output that cannot be recorded safely; " +
          "download uncompressed JSON instead"
      );
    }
    const format = typeof params.format === "string" ? params.format : "json";
    const requestUrl = new URL(
      `${baseUrl}/datasets/v3/snapshot/${encodeURIComponent(snapshotId(params))}`
    );
    requestUrl.searchParams.set("format", format);
    appendNativeQueryParams(
      requestUrl,
      params,
      new Set(["snapshot_id", "snapshotId", "id", "format"])
    );

    return {
      url: requestUrl.toString(),
      method: "GET",
      headers,
      body: null,
      useTextParser: format !== "json",
    };
  }

  if (tool === "discover") {
    const query = requireValue(params.query ?? params.q, "query");
    const payload: Record<string, any> = { ...params, query };
    delete payload.q;
    return {
      url: `${baseUrl}/discover`,
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify(payload),
      useTextParser: false,
    };
  }

  throw new Error(`Unsupported Bright Data tool mapper: ${tool}`);
}

export function buildBrightDataSummary(
  tool: string,
  raw: any
): Record<string, any> | null {
  if (raw == null) return null;

  if (tool === "serp") {
    return {
      results_count: raw.organic?.length ?? 0,
      query: raw.general?.query ?? null,
      search_type: raw.general?.search_type ?? null,
      country: raw.general?.country ?? null,
    };
  }

  if (tool === "datasetsList") {
    return { datasets_count: Array.isArray(raw) ? raw.length : 0 };
  }

  if (tool === "datasetMetadata") {
    return {
      dataset_id: raw.id ?? null,
      fields_count: raw.fields && typeof raw.fields === "object"
        ? Object.keys(raw.fields).length
        : 0,
    };
  }

  if (tool === "scrape") {
    return {
      // Text-parser payloads (csv/ndjson-as-text) carry no record array; report
      // content length instead of a misleading records_count of 1.
      ...(typeof raw === "string"
        ? { content_length: raw.length }
        : { records_count: Array.isArray(raw) ? raw.length : raw ? 1 : 0 }),
      snapshot_id: typeof raw === "object" && raw !== null ? (raw.snapshot_id ?? null) : null,
      cost_usd: typeof raw?.cost === "number" ? raw.cost : null,
    };
  }

  if (tool === "trigger" || tool === "crawl") {
    return {
      snapshot_id: raw.snapshot_id ?? raw.id ?? null,
      cost_usd: typeof raw.cost === "number" ? raw.cost : null,
    };
  }

  if (tool === "progress") {
    return {
      snapshot_id: raw.snapshot_id ?? null,
      dataset_id: raw.dataset_id ?? null,
      status: raw.status ?? null,
    };
  }

  if (tool === "snapshotMetadata") {
    return {
      snapshot_id: raw.id ?? raw.snapshot_id ?? null,
      dataset_id: raw.dataset_id ?? null,
      status: raw.status ?? null,
      records_count: raw.dataset_size ?? null,
      cost_usd: typeof raw.cost === "number" ? raw.cost : null,
    };
  }

  if (tool === "cancel") {
    return {
      snapshot_id: raw.snapshot_id ?? raw.id ?? null,
      status: raw.status ?? "cancel_requested",
    };
  }

  if (tool === "snapshot") {
    return typeof raw === "string"
      ? { content_length: raw.length }
      : { records_count: Array.isArray(raw) ? raw.length : raw ? 1 : 0 };
  }

  if (tool === "discover") {
    return {
      task_id: raw.task_id ?? null,
      status: raw.status ?? null,
      cost_usd: typeof raw.cost === "number" ? raw.cost : null,
    };
  }

  if (tool === "unlocker") {
    return {
      content_length:
        typeof raw === "string"
          ? raw.length
          : typeof raw.body === "string"
            ? raw.body.length
            : 0,
      cost_usd: typeof raw?.cost === "number" ? raw.cost : null,
    };
  }

  return null;
}
