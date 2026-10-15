import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { BrightDataAdapter } from "../dist/adapters/brightdata.js";
import { providerRegistry } from "../dist/providers.js";
import { getToolProfile } from "../dist/registry/tool-profiles.js";
import {
  buildBrightDataToolRequest,
  buildBrightDataSummary,
} from "../dist/tools/brightdata.js";
import { executeToolCall } from "../dist/tools/substrate.js";

function config(overrides = {}) {
  return {
    capabilities: {
      search: { providers: ["brightdata"], strategy: "random" },
      extract: { providers: ["brightdata"], strategy: "random" },
      crawl: { providers: [], strategy: "random" },
    },
    providers: {
      brightdata: {
        keyPool: { keys: ["env:BRIGHTDATA_TEST_KEY"], strategy: "round-robin" },
        options: {
          serpZone: "serp_test",
          unlockerZone: "unlocker_test",
          searchEngine: "google",
          searchCountry: "us",
          maxStructuredInputsPerCall: 2,
          ...overrides,
        },
      },
    },
    logging: {},
  };
}

async function withMockFetch(handler, fn) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("Bright Data is registered for search and extract but not crawl", () => {
  assert.deepEqual(providerRegistry.brightdata.capabilities, ["search", "extract"]);
  assert.equal(typeof providerRegistry.brightdata.createAdapter().search, "function");
  assert.equal(typeof providerRegistry.brightdata.createAdapter().extract, "function");
});

test("Bright Data normalized backers are wired while structured scrapers stay direct/provider-native", () => {
  assert.equal(getToolProfile("brightdata.serp")?.status, "wired");
  assert.equal(getToolProfile("brightdata.serp")?.adapterMethod, "search");
  assert.equal(getToolProfile("brightdata.unlocker")?.status, "wired");
  assert.equal(getToolProfile("brightdata.unlocker")?.adapterMethod, "extract");
  for (const id of [
    "brightdata.datasetsList",
    "brightdata.datasetMetadata",
    "brightdata.scrape",
    "brightdata.trigger",
    "brightdata.progress",
    "brightdata.snapshotMetadata",
    "brightdata.cancel",
    "brightdata.snapshot",
  ]) {
    assert.equal(getToolProfile(id)?.status, "direct", `${id} should be direct-callable`);
    assert.deepEqual(getToolProfile(id)?.categories, []);
  }
});

test("SERP adapter sends configured zone and normalizes organic results", async () => {
  const adapter = new BrightDataAdapter();
  let requestBody;

  await withMockFetch(async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return new Response(JSON.stringify({
      organic: [
        {
          title: "Example result",
          link: "https://example.com/result",
          description: "Example description",
          global_rank: 3,
        },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }, async () => {
    const results = await adapter.search("bright data test", "secret", {
      providerOptions: config().providers.brightdata.options,
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].title, "Example result");
    assert.equal(results[0].url, "https://example.com/result");
    assert.equal(results[0].source, "brightdata");
    // Organic rank is read from the parsed-SERP `global_rank` field.
    assert.equal(results[0].score, 1 / 3);
  });

  assert.equal(requestBody.zone, "serp_test");
  assert.equal(requestBody.format, "json");
  assert.match(requestBody.url, /google\.com\/search\?q=bright%20data%20test/);
});

test("Bright Data rejects plain-text output it cannot return", async () => {
  const adapter = new BrightDataAdapter();
  let fetchCalled = false;

  await withMockFetch(async (_url, init) => {
    fetchCalled = true;
    return new Response("# Extracted page\nHello", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  }, async () => {
    await assert.rejects(() => adapter.extract("https://example.com/page", "secret", {
      format: "text",
      providerOptions: config().providers.brightdata.options,
    }), /does not support plain-text extract output/);
  });

  assert.equal(fetchCalled, false, "unsupported output is rejected before the provider call");
});

test("Unlocker adapter requests Markdown when markdown output is requested", async () => {
  const adapter = new BrightDataAdapter();
  let requestBody;

  await withMockFetch(async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return new Response("# Extracted page\nHello", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  }, async () => {
    const result = await adapter.extract("https://example.com/page", "secret", {
      format: "markdown",
      providerOptions: config().providers.brightdata.options,
    });
    assert.equal(result.content, "# Extracted page\nHello");
    assert.equal(result.url, "https://example.com/page");
    assert.equal(result.source, "brightdata");
  });

  assert.equal(requestBody.zone, "unlocker_test");
  assert.equal(requestBody.format, "raw");
  assert.equal(requestBody.data_format, "markdown");
});

test("unlocker adapter rejects empty extracted content as a failed attempt", async () => {
  const adapter = new BrightDataAdapter();
  await withMockFetch(async () => new Response("   \n  ", {
    status: 200,
    headers: { "content-type": "text/plain" },
  }), async () => {
    await assert.rejects(
      () => adapter.extract("https://example.com/page", "secret", {
        providerOptions: config().providers.brightdata.options,
      }),
      /No content extracted/
    );
  });
});

test("adapter fails closed without configured zones", async () => {
  const adapter = new BrightDataAdapter();
  await assert.rejects(
    () => adapter.search("q", "secret", { providerOptions: {} }),
    /providers\.brightdata\.options\.zone \(legacy alias: serpZone\)/
  );
  await assert.rejects(
    () => adapter.extract("https://example.com/page", "secret", { providerOptions: {} }),
    /providers\.brightdata\.options\.unlockerZone \(legacy alias: zone\)/
  );
});

test("adapter accepts profile-declared zone/country keys (legacy aliases still work)", async () => {
  const adapter = new BrightDataAdapter();
  const bodies = [];

  await withMockFetch(async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ organic: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }, async () => {
    // Profile-declared keys take precedence over the legacy aliases.
    await adapter.search("q", "secret", {
      providerOptions: { zone: "z_new", serpZone: "z_old", country: "de", searchCountry: "us" },
    });
    await adapter.search("q", "secret", {
      providerOptions: { serpZone: "z_old", searchCountry: "us" },
    });
  });

  assert.equal(bodies[0].zone, "z_new");
  assert.equal(bodies[0].country, "de");
  assert.equal(bodies[1].zone, "z_old");
  assert.equal(bodies[1].country, "us");
});

test("unlocker adapter honors format/data_format providerOptions", async () => {
  const adapter = new BrightDataAdapter();
  const bodies = [];

  await withMockFetch(async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response("# ok", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  }, async () => {
    const options = { providerOptions: config().providers.brightdata.options };
    await adapter.extract("https://example.com/page", "secret", options);
    await adapter.extract("https://example.com/page", "secret", {
      providerOptions: {
        ...config().providers.brightdata.options,
        format: "json",
        data_format: "html",
      },
    });
  });

  assert.equal(bodies[0].format, "raw");
  assert.equal(bodies[1].format, "raw");
  assert.equal(bodies[0].data_format, "markdown");
  assert.equal(bodies[1].data_format, "html");
});

test("adapter surfaces non-200 HTTP errors from the SERP endpoint", async () => {
  const adapter = new BrightDataAdapter();
  await withMockFetch(async () => new Response(JSON.stringify({ error: "boom" }), {
    status: 400,
    headers: { "content-type": "application/json" },
  }), async () => {
    await assert.rejects(
      () => adapter.search("q", "secret", {
        providerOptions: config().providers.brightdata.options,
      }),
      /HTTP 400/
    );
  });
});

test("adapter falls back to env zones when options are absent", async () => {
  const prevSerp = process.env.BRIGHTDATA_SERP_ZONE;
  const prevUnlocker = process.env.BRIGHTDATA_UNLOCKER_ZONE;
  process.env.BRIGHTDATA_SERP_ZONE = "serp_env";
  process.env.BRIGHTDATA_UNLOCKER_ZONE = "unlocker_env";
  try {
    const adapter = new BrightDataAdapter();
    let serpBody;
    await withMockFetch(async (_url, init) => {
      serpBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ organic: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }, async () => {
      await adapter.search("q", "secret", { providerOptions: {} });
    });
    assert.equal(serpBody.zone, "serp_env");

    let unlockerBody;
    await withMockFetch(async (_url, init) => {
      unlockerBody = JSON.parse(init.body);
      return new Response("# Page\nok", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }, async () => {
      await adapter.extract("https://example.com/page", "secret", { providerOptions: {} });
    });
    assert.equal(unlockerBody.zone, "unlocker_env");
  } finally {
    if (prevSerp === undefined) delete process.env.BRIGHTDATA_SERP_ZONE;
    else process.env.BRIGHTDATA_SERP_ZONE = prevSerp;
    if (prevUnlocker === undefined) delete process.env.BRIGHTDATA_UNLOCKER_ZONE;
    else process.env.BRIGHTDATA_UNLOCKER_ZONE = prevUnlocker;
  }
});

test("dataset discovery and metadata build account-scoped GET requests", () => {
  const list = buildBrightDataToolRequest("datasetsList", {}, "secret", config());
  assert.equal(list.method, "GET");
  assert.equal(list.url, "https://api.brightdata.com/datasets/list");
  assert.equal(list.headers.Authorization, "Bearer secret");

  const metadata = buildBrightDataToolRequest(
    "datasetMetadata",
    { dataset_id: "gd_product" },
    "secret",
    config()
  );
  assert.equal(metadata.method, "GET");
  assert.match(metadata.url, /\/datasets\/gd_product\/metadata$/);
});

test("structured scrape separates dataset ID from input body and preserves native query controls", () => {
  const request = buildBrightDataToolRequest(
    "scrape",
    {
      dataset_id: "gd_product",
      input: { url: "https://example.com/product" },
      format: "json",
      type: "discover_new",
      discover_by: "input_filters",
    },
    "secret",
    config()
  );

  const url = new URL(request.url);
  assert.equal(url.pathname, "/datasets/v3/scrape");
  assert.equal(url.searchParams.get("dataset_id"), "gd_product");
  assert.equal(url.searchParams.get("format"), "json");
  assert.equal(url.searchParams.get("type"), "discover_new");
  assert.equal(url.searchParams.get("discover_by"), "input_filters");
  assert.deepEqual(JSON.parse(request.body), {
    input: [{ url: "https://example.com/product" }],
  });
});

test("async trigger preserves snapshot lifecycle and native query controls", () => {
  const request = buildBrightDataToolRequest(
    "trigger",
    {
      dataset_id: "gd_search",
      input: { keyword: "gpu" },
      include_errors: true,
      custom_output_fields: "url,title,price",
      type: "discover_new",
    },
    "secret",
    config()
  );

  const url = new URL(request.url);
  assert.equal(url.pathname, "/datasets/v3/trigger");
  assert.equal(url.searchParams.get("dataset_id"), "gd_search");
  assert.equal(url.searchParams.get("include_errors"), "true");
  assert.equal(url.searchParams.get("custom_output_fields"), "url,title,price");
  assert.equal(url.searchParams.get("type"), "discover_new");
  assert.deepEqual(JSON.parse(request.body), [{ keyword: "gpu" }]);

  assert.equal(buildBrightDataSummary("trigger", { snapshot_id: "s_123" }).snapshot_id, "s_123");
});

test("progress, metadata, cancellation, and download use snapshot IDs correctly", () => {
  const progress = buildBrightDataToolRequest("progress", { snapshot_id: "s_123" }, "secret", config());
  assert.equal(new URL(progress.url).pathname, "/datasets/v3/progress/s_123");

  const metadata = buildBrightDataToolRequest(
    "snapshotMetadata",
    { snapshot_id: "s_123" },
    "secret",
    config()
  );
  assert.equal(new URL(metadata.url).pathname, "/datasets/snapshots/s_123");
  assert.equal(
    buildBrightDataSummary("snapshotMetadata", {
      id: "s_123",
      dataset_id: "gd_product",
      status: "ready",
      cost: 1.25,
      dataset_size: 12,
    }).cost_usd,
    1.25
  );

  const cancel = buildBrightDataToolRequest("cancel", { snapshot_id: "s_123" }, "secret", config());
  assert.equal(cancel.method, "POST");
  assert.equal(new URL(cancel.url).pathname, "/datasets/v3/snapshot/s_123/cancel");

  const download = buildBrightDataToolRequest(
    "snapshot",
    { snapshot_id: "s_123", format: "json", part: 2, batch_size: 1000 },
    "secret",
    config()
  );
  const downloadUrl = new URL(download.url);
  assert.equal(downloadUrl.pathname, "/datasets/v3/snapshot/s_123");
  assert.equal(downloadUrl.searchParams.get("format"), "json");
  assert.equal(downloadUrl.searchParams.get("part"), "2");
  assert.equal(downloadUrl.searchParams.get("batch_size"), "1000");
});

test("unlocker direct tool uses the text parser for non-JSON formats and honors the timeout option", () => {
  const html = buildBrightDataToolRequest(
    "unlocker",
    { url: "https://example.com/page", format: "html", data_format: "html" },
    "secret",
    config()
  );
  assert.equal(html.method, "POST");
  assert.equal(html.useTextParser, true, "HTML unlocker output must not be JSON-parsed");
  assert.equal(html.timeoutMs, undefined);

  const slow = buildBrightDataToolRequest(
    "unlocker",
    { url: "https://example.com/page" },
    "secret",
    config({ unlockerTimeoutMs: 45000 })
  );
  assert.equal(slow.useTextParser, true, "raw default output is text");
  assert.equal(slow.timeoutMs, 45000);

  assert.throws(
    () => buildBrightDataToolRequest(
      "unlocker",
      { url: "https://example.com/page", data_format: "screenshot" },
      "secret",
      config()
    ),
    /binary PNG/
  );
});

test("discover requires a query and normalizes the q alias", () => {
  assert.throws(
    () => buildBrightDataToolRequest("discover", {}, "secret", config()),
    /query is required/
  );
  const request = buildBrightDataToolRequest("discover", { q: "shoes" }, "secret", config());
  assert.equal(request.method, "POST");
  assert.equal(new URL(request.url).pathname, "/discover");
  assert.deepEqual(JSON.parse(request.body), { query: "shoes" });
});

test("serp summary reads only fields present in the parsed SERP JSON", () => {
  const summary = buildBrightDataSummary("serp", {
    organic: [{ link: "https://example.com" }],
    general: { query: "pizza", search_type: "text", country: "United States" },
  });
  assert.equal(summary.results_count, 1);
  assert.equal(summary.query, "pizza");
  assert.equal(summary.search_type, "text");
  assert.equal(summary.country, "United States");
  // Fields that never populate in parsed SERP JSON are omitted, not reported
  // as permanent nulls.
  assert.equal("search_engine" in summary, false);
  assert.equal("cost_usd" in summary, false);
});

test("bodyless GET tools do not claim a JSON request body", () => {
  const list = buildBrightDataToolRequest("datasetsList", {}, "secret", config());
  assert.equal(list.method, "GET");
  assert.equal(list.headers["Content-Type"], undefined);
  const progress = buildBrightDataToolRequest("progress", { snapshot_id: "s_1" }, "secret", config());
  assert.equal(progress.headers["Content-Type"], undefined);
  const serp = buildBrightDataToolRequest("serp", { query: "x" }, "secret", config());
  assert.equal(serp.headers["Content-Type"], "application/json");
});

test("serp direct tool uses the text parser for non-JSON formats", () => {
  const raw = buildBrightDataToolRequest("serp", { query: "x", format: "raw" }, "secret", config());
  assert.equal(raw.useTextParser, true, "serp format=raw returns HTML and must not be JSON-parsed");
  const json = buildBrightDataToolRequest("serp", { query: "x", format: "json" }, "secret", config());
  assert.equal(json.useTextParser, false);
  const defaulted = buildBrightDataToolRequest("serp", { query: "x" }, "secret", config());
  assert.equal(defaulted.useTextParser, false, "json is the serp default format");
});

test("snapshot rejects compressed binary downloads", () => {
  assert.throws(
    () => buildBrightDataToolRequest(
      "snapshot",
      { snapshot_id: "s_1", compress: true },
      "secret",
      config()
    ),
    /compress/
  );
  assert.throws(
    () => buildBrightDataToolRequest(
      "snapshot",
      { snapshot_id: "s_1", compress: "true" },
      "secret",
      config()
    ),
    /compress/
  );
  const plain = buildBrightDataToolRequest("snapshot", { snapshot_id: "s_1" }, "secret", config());
  assert.equal(plain.method, "GET");
  assert.equal(plain.useTextParser, false);
});

test("trigger/crawl discovery limits are capped before any paid request", () => {
  assert.throws(
    () => buildBrightDataToolRequest(
      "trigger",
      { dataset_id: "gd_search", input: { keyword: "gpu" }, limit_per_input: 500 },
      "secret",
      config({ maxDiscoveryResultsPerInput: 20 })
    ),
    /limit_per_input 500 exceeds configured maximum 20/
  );
  const allowed = buildBrightDataToolRequest(
    "trigger",
    { dataset_id: "gd_search", input: { keyword: "gpu" }, limit_per_input: 20 },
    "secret",
    config({ maxDiscoveryResultsPerInput: 20 })
  );
  assert.equal(new URL(allowed.url).searchParams.get("limit_per_input"), "20");
});

test("string summary payloads report content length instead of a bogus record count", () => {
  const scrapeText = buildBrightDataSummary("scrape", "col1,col2\n1,2");
  assert.equal(scrapeText.content_length, "col1,col2\n1,2".length);
  assert.equal("records_count" in scrapeText, false);
  const scrapeList = buildBrightDataSummary("scrape", [{ url: "a" }, { url: "b" }]);
  assert.equal(scrapeList.records_count, 2);

  const snapshotText = buildBrightDataSummary("snapshot", "<html>page</html>");
  assert.equal(snapshotText.content_length, "<html>page</html>".length);
  assert.equal("records_count" in snapshotText, false);
  const snapshotList = buildBrightDataSummary("snapshot", [{ id: 1 }]);
  assert.equal(snapshotList.records_count, 1);
});

test("structured request input count is capped before any paid request", () => {
  assert.throws(
    () => buildBrightDataToolRequest(
      "scrape",
      {
        dataset_id: "gd_product",
        inputs: [{ url: "a" }, { url: "b" }, { url: "c" }],
      },
      "secret",
      config({ maxStructuredInputsPerCall: 2 })
    ),
    /configured maximum is 2/
  );
});

test("direct dataset discovery is catalogued and logs only safe key reference", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coldsearch-brightdata-"));
  const usagePath = path.join(tmpDir, "usage.jsonl");
  process.env.BRIGHTDATA_TEST_KEY = "super-secret-bright-data-key";
  const cfg = config();
  cfg.logging = { usage: { path: usagePath } };
  // Pin history to the temp dir and disable the cache so this test never
  // touches real user history or the replay cache.
  cfg.history = { path: path.join(tmpDir, "history.jsonl") };
  cfg.cache = { enabled: false };

  try {
    await withMockFetch(async (_url, init) => {
      assert.equal(init.headers.Authorization, "Bearer super-secret-bright-data-key");
      return new Response(JSON.stringify([{ id: "gd_product", name: "Products" }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }, async () => {
      const result = await executeToolCall("brightdata", "datasetsList", {}, cfg);
      assert.equal(result.ok, true);
      assert.equal(result.catalogued, true);
      assert.equal(result.summary.datasets_count, 1);
      assert.deepEqual(result.raw, [{ id: "gd_product", name: "Products" }]);
    });

    const log = fs.readFileSync(usagePath, "utf8");
    assert.match(log, /env:BRIGHTDATA_TEST_KEY/);
    assert.doesNotMatch(log, /super-secret-bright-data-key/);
  } finally {
    delete process.env.BRIGHTDATA_TEST_KEY;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("substrate forwards the unlocker request body on the text-parser path", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coldsearch-brightdata-"));
  const usagePath = path.join(tmpDir, "usage.jsonl");
  process.env.BRIGHTDATA_TEST_KEY = "super-secret-bright-data-key";
  const cfg = config();
  cfg.logging = { usage: { path: usagePath } };
  cfg.history = { path: path.join(tmpDir, "history.jsonl") };
  cfg.cache = { enabled: false };

  try {
    let receivedBody;
    await withMockFetch(async (_url, init) => {
      assert.equal(init.headers.Authorization, "Bearer super-secret-bright-data-key");
      receivedBody = JSON.parse(init.body);
      return new Response("# Extracted\nHello", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }, async () => {
      const result = await executeToolCall(
        "brightdata",
        "unlocker",
        { url: "https://example.com/page" },
        cfg
      );
      assert.equal(result.ok, true);
      assert.equal(result.raw, "# Extracted\nHello");
    });
    // The unlocker direct call uses the text parser (raw format); its POST body
    // must still reach the upstream API, not be dropped in the substrate.
    assert.equal(receivedBody.zone, "unlocker_test");
    assert.equal(receivedBody.url, "https://example.com/page");
  } finally {
    delete process.env.BRIGHTDATA_TEST_KEY;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("unconfigured brightdata fails before any HTTP request", async () => {
  const cfg = config();
  delete cfg.providers.brightdata;
  let fetchCalled = false;
  await withMockFetch(async () => {
    fetchCalled = true;
    return new Response("{}", { status: 200 });
  }, async () => {
    const result = await executeToolCall("brightdata", "serp", { query: "x" }, cfg);
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "PROVIDER_NOT_CONFIGURED");
    assert.match(result.error?.message, /add \[providers\.brightdata\]/);
  });
  assert.equal(fetchCalled, false, "no HTTP request may fire without a configured brightdata block");
});

test("usage log records masked zone and summary cost/counts, never the raw zone or key", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coldsearch-brightdata-"));
  const usagePath = path.join(tmpDir, "usage.jsonl");
  process.env.BRIGHTDATA_TEST_KEY = "super-secret-bright-data-key";
  const cfg = config();
  cfg.logging = { usage: { path: usagePath } };
  cfg.history = { path: path.join(tmpDir, "history.jsonl") };
  cfg.cache = { enabled: false };

  try {
    // serp call: masked zone + result count.
    await withMockFetch(async () => new Response(JSON.stringify({
      organic: [{ link: "https://example.com" }],
      general: { query: "pizza", search_type: "text", country: "us" },
    }), { status: 200, headers: { "content-type": "application/json" } }), async () => {
      const result = await executeToolCall(
        "brightdata",
        "serp",
        { query: "pizza", zone: "brd-customer_abc123-zone-serp" },
        cfg
      );
      assert.equal(result.ok, true, result.error?.message);
    });

    // snapshotMetadata call: provider-reported cost + dataset size.
    await withMockFetch(async () => new Response(JSON.stringify({
      id: "s_1",
      dataset_id: "gd_product",
      status: "ready",
      cost: 1.25,
      dataset_size: 12,
    }), { status: 200, headers: { "content-type": "application/json" } }), async () => {
      const result = await executeToolCall(
        "brightdata",
        "snapshotMetadata",
        { snapshot_id: "s_1" },
        cfg
      );
      assert.equal(result.ok, true, result.error?.message);
    });

    const log = fs.readFileSync(usagePath, "utf8");
    assert.ok(!log.includes("brd-customer_abc123"), "raw zone leaked into the usage log");
    assert.ok(!log.includes("super-secret-bright-data-key"), "API key leaked into the usage log");
    const entries = log.trim().split("\n").map((line) => JSON.parse(line));
    const serpEntry = entries.find((e) => e.tool === "serp");
    assert.equal(serpEntry.zone, "serp", "usage log should carry the masked zone suffix");
    assert.equal(serpEntry.result_count, 1);
    assert.equal(serpEntry.cost_usd, undefined);
    const metaEntry = entries.find((e) => e.tool === "snapshotMetadata");
    assert.equal(metaEntry.cost_usd, 1.25);
    assert.equal(metaEntry.result_count, 12);
    assert.equal(metaEntry.zone, undefined, "dataset tools have no zone to attribute");
  } finally {
    delete process.env.BRIGHTDATA_TEST_KEY;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
