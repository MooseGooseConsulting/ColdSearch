import test from "node:test";
import assert from "node:assert/strict";
import { FanoutEngine } from "../dist/engine/fanout.js";
import { providerRegistry } from "../dist/providers.js";
import { installFetchMock, jsonResponse, textResponse, rawResponse } from "./adapters/_fetch-mock.mjs";

function makeConfig(overrides) {
  return {
    capabilities: {
      search: { providers: ["brave", "serper"], strategy: "all" },
      extract: { providers: ["exa", "jina"], strategy: "all" },
      crawl: { providers: ["tavily", "exa"], strategy: "all" },
      ...(overrides?.capabilities || {}),
    },
    providers: {
      brave: { keyPool: { keys: ["k"] } },
      serper: { keyPool: { keys: ["k"] } },
      exa: { keyPool: { keys: ["k"] } },
      jina: { keyPool: { keys: [] } },
      tavily: { keyPool: { keys: ["k"] } },
      ...(overrides?.providers || {}),
    },
  };
}

test('strategy: "random" selects exactly one provider', async () => {
  const originalRandom = Math.random;
  Math.random = () => 0.9; // pick last provider

  const restore = installFetchMock({
    "*": async ({ url }) => {
      if (url.includes("brave.com")) return jsonResponse({ web: { results: [] } });
      if (url.includes("serper.dev")) return jsonResponse({ organic: [] });
      throw new Error(`unexpected url: ${url}`);
    },
  });

  try {
    const engine = new FanoutEngine(
      makeConfig({
        capabilities: { search: { providers: ["brave", "serper"], strategy: "random" } },
      })
    );

    const out = await engine.search("q", { limit: 5 });
    assert.equal(out.providersUsed.length, 1);
    assert.equal(out.providersUsed[0], "serper");
  } finally {
    restore();
    Math.random = originalRandom;
  }
});

test("parallel fanout collects and merges results from multiple providers", async () => {
  const restore = installFetchMock({
    "*": async ({ url }) => {
      if (url.includes("brave.com")) {
        return jsonResponse({
          web: { results: [{ title: "B", url: "https://b.example", description: "bb", relevance_score: 0.9 }] },
        });
      }
      if (url.includes("serper.dev")) {
        return jsonResponse({
          organic: [{ title: "S", link: "https://s.example", snippet: "ss", position: 1 }],
        });
      }
      throw new Error(`unexpected url: ${url}`);
    },
  });

  try {
    const engine = new FanoutEngine(makeConfig());
    const out = await engine.search("q", { limit: 10, rerankStrategy: "none" });
    assert.deepEqual(new Set(out.providersUsed), new Set(["brave", "serper"]));
    assert.equal(out.results.length, 2);
    assert.ok(out.results.some((r) => r.url === "https://b.example"));
    assert.ok(out.results.some((r) => r.url === "https://s.example"));
  } finally {
    restore();
  }
});

test("sequential extract tries providers in order and returns on first success", async () => {
  const restore = installFetchMock({
    "POST https://api.exa.ai/contents": async () => rawResponse("nope", { status: 500 }),
    "*": async ({ url }) => {
      if (url.startsWith("https://r.jina.ai/")) {
        return textResponse("Title: T\n\nBody");
      }
      throw new Error(`unexpected url: ${url}`);
    },
  });

  try {
    const engine = new FanoutEngine(makeConfig());
    const out = await engine.extract("https://x.example", { limit: 1 });
    assert.equal(out.provider, "jina");
    assert.equal(out.result?.content, "Body");
    assert.ok(out.errors?.exa);
  } finally {
    restore();
  }
});

test("Exa plain-text extract rejects before the request and fanout falls back", async () => {
  let exaRequests = 0;
  let jinaFormat;
  const restore = installFetchMock({
    "POST https://api.exa.ai/contents": async () => {
      exaRequests++;
      return jsonResponse({ results: [{ text: "Markdown **body**" }] });
    },
    "GET https://r.jina.ai/https://x.example": async ({ init }) => {
      jinaFormat = init.headers["X-Return-Format"];
      return textResponse("Plain text body");
    },
  });

  try {
    const engine = new FanoutEngine(
      makeConfig({ capabilities: { extract: { providers: ["exa", "jina"], strategy: "all" } } })
    );
    const out = await engine.extract("https://x.example", { limit: 1, format: "text" });
    assert.equal(exaRequests, 0, "Exa must reject the unsupported format before an upstream call");
    assert.equal(out.provider, "jina");
    assert.equal(jinaFormat, "text");
    assert.equal(out.result.content, "Plain text body");
    assert.match(out.errors.exa, /does not support plain-text extract output/);
  } finally {
    restore();
  }
});

test("sequential crawl tries providers in order and returns on first success", async () => {
  const restore = installFetchMock({
    "POST https://api.tavily.com/crawl": async () => rawResponse("no", { status: 401 }),
    "POST https://api.exa.ai/search": async () => jsonResponse({ results: [{ url: "https://x.example/a" }] }),
    "POST https://api.exa.ai/contents": async () =>
      jsonResponse({ results: [{ url: "https://x.example/a", title: "A", text: "a" }] }),
  });

  try {
    const engine = new FanoutEngine(
      makeConfig({
        capabilities: { crawl: { providers: ["tavily", "exa"], strategy: "all" } },
      })
    );
    const out = await engine.crawl("https://x.example", { limit: 1 });
    assert.equal(out.provider, "exa");
    assert.equal(out.results.length, 1);
    assert.ok(out.errors?.tavily);
  } finally {
    restore();
  }
});

test("pending Firecrawl crawl falls through to a completed provider", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, _delay, ...args) => originalSetTimeout(fn, 0, ...args);
  const restore = installFetchMock({
    "POST https://api.firecrawl.dev/v2/crawl": async () =>
      jsonResponse({ success: true, id: "job-pending", url: "https://x.example" }),
    "GET https://api.firecrawl.dev/v2/crawl/job-pending": async () =>
      jsonResponse({ success: true, status: "scraping" }),
    "POST https://api.exa.ai/search": async () =>
      jsonResponse({ results: [{ url: "https://x.example/a" }] }),
    "POST https://api.exa.ai/contents": async () =>
      jsonResponse({ results: [{ url: "https://x.example/a", title: "A", text: "a" }] }),
  });

  try {
    const engine = new FanoutEngine(
      makeConfig({
        capabilities: { crawl: { providers: ["firecrawl", "exa"], strategy: "all" } },
        providers: { firecrawl: { keyPool: { keys: ["k"] } } },
      })
    );
    const out = await engine.crawl("https://x.example", { limit: 1 });
    assert.equal(out.provider, "exa");
    assert.equal(out.status, "pending");
    assert.equal(out.results.length, 1, "pending jobs are not counted as crawled pages");
    assert.equal(out.results[0].url, "https://x.example/a");
    assert.equal(out.results[0].status, "completed");
    assert.deepEqual(out.pendingJobs, [
      { provider: "firecrawl", jobId: "job-pending", url: "https://x.example" },
    ]);
    assert.equal(out.attempts[0].provider, "firecrawl");
    assert.equal(out.attempts[0].success, false);
    assert.equal(out.attempts[0].pending, true);
    assert.equal(out.attempts[1].provider, "exa");
    assert.equal(out.attempts[1].success, true);
  } finally {
    restore();
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("pending crawl fallback preserves every pending job id and status", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, _delay, ...args) => originalSetTimeout(fn, 0, ...args);
  let nextJob = 0;
  const restore = installFetchMock({
    "POST https://api.firecrawl.dev/v2/crawl": async () =>
      jsonResponse({ success: true, id: `job-${++nextJob}`, url: "https://x.example" }),
    "GET https://api.firecrawl.dev/v2/crawl/job-1": async () =>
      jsonResponse({ success: true, status: "scraping" }),
    "GET https://api.firecrawl.dev/v2/crawl/job-2": async () =>
      jsonResponse({ success: true, status: "scraping" }),
  });

  try {
    const engine = new FanoutEngine(
      makeConfig({
        capabilities: { crawl: { providers: ["firecrawl", "firecrawl"], strategy: "all" } },
        providers: { firecrawl: { keyPool: { keys: ["k"] } } },
      })
    );
    const out = await engine.crawl("https://x.example", { limit: 1 });
    assert.equal(out.status, "pending");
    assert.deepEqual(out.results, [], "pending handles are not page results");
    assert.deepEqual(out.pendingJobs.map((job) => job.jobId), ["job-1", "job-2"]);
    assert.ok(out.pendingJobs.every((job) => job.provider === "firecrawl"));
    assert.ok(out.attempts.every((attempt) => attempt.pending && !attempt.success));
  } finally {
    restore();
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("a confirmed Firecrawl terminal failure drops its saved job before fallback", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, _delay, ...args) => originalSetTimeout(fn, 0, ...args);
  const restore = installFetchMock({
    "GET https://api.firecrawl.dev/v2/crawl/terminal-job": async () =>
      jsonResponse({
        success: true,
        status: "failed",
        error: "crawl was rejected",
        data: [{ markdown: "must not be accepted", metadata: { sourceURL: "https://x.example/bad" } }],
      }),
    "POST https://api.exa.ai/search": async () =>
      jsonResponse({ results: [{ url: "https://x.example/a", title: "A" }] }),
    "POST https://api.exa.ai/contents": async () =>
      jsonResponse({ results: [{ url: "https://x.example/a", title: "A", text: "page" }] }),
  });

  try {
    const engine = new FanoutEngine(
      makeConfig({
        capabilities: { crawl: { providers: ["firecrawl", "exa"], strategy: "all" } },
        providers: { firecrawl: { keyPool: { keys: ["k"] } } },
      })
    );
    const out = await engine.crawl("https://x.example", {
      limit: 1,
      resumePendingJobs: [
        { provider: "firecrawl", jobId: "terminal-job", url: "https://x.example" },
      ],
    });

    assert.equal(out.status, "completed");
    assert.deepEqual(out.pendingJobs, []);
    assert.equal(out.results.length, 1);
    assert.match(out.errors.firecrawl, /terminal-job.*crawl was rejected/);
  } finally {
    restore();
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("all saved Firecrawl jobs for one provider are polled before returning", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, _delay, ...args) => originalSetTimeout(fn, 0, ...args);
  let startCount = 0;
  let firstJobPolls = 0;
  let secondJobPolls = 0;
  const restore = installFetchMock({
    "POST https://api.firecrawl.dev/v2/crawl": async () => {
      startCount++;
      return jsonResponse({ success: true, id: "unexpected-new-job" });
    },
    "GET https://api.firecrawl.dev/v2/crawl/first-saved-job": async () => {
      firstJobPolls++;
      return jsonResponse({ success: true, status: "scraping" });
    },
    "GET https://api.firecrawl.dev/v2/crawl/second-saved-job": async () => {
      secondJobPolls++;
      return jsonResponse({
        success: true,
        status: "completed",
        data: [{ markdown: "Second job page", metadata: { sourceURL: "https://x.example/second" } }],
      });
    },
  });

  try {
    const engine = new FanoutEngine(
      makeConfig({
        capabilities: { crawl: { providers: ["firecrawl", "exa"], strategy: "all" } },
        providers: { firecrawl: { keyPool: { keys: ["k"] } } },
      })
    );
    const out = await engine.crawl("https://x.example", {
      limit: 1,
      resumePendingJobs: [
        { provider: "firecrawl", jobId: "first-saved-job", url: "https://x.example" },
        { provider: "firecrawl", jobId: "second-saved-job", url: "https://x.example" },
      ],
    });

    assert.equal(firstJobPolls, 30, "the first still-running job is polled to the adapter budget");
    assert.equal(secondJobPolls, 1, "the second saved handle is also polled in the same resume");
    assert.equal(startCount, 0, "resuming saved jobs must not start a new crawl for that provider");
    assert.equal(out.provider, "firecrawl");
    assert.equal(out.status, "pending");
    assert.deepEqual(out.results.map((result) => result.url), ["https://x.example/second"]);
    assert.deepEqual(out.pendingJobs, [
      { provider: "firecrawl", jobId: "first-saved-job", url: "https://x.example" },
    ]);
  } finally {
    restore();
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("a resumed handle preserves completed pages returned alongside pending pages", async () => {
  const originalCreateAdapter = providerRegistry.firecrawl.createAdapter;
  let resumedJobId;
  providerRegistry.firecrawl.createAdapter = () => ({
    name: "firecrawl",
    capabilities: ["crawl"],
    search: async () => [],
    crawl: async (_url, _apiKey, options) => {
      resumedJobId = options.resumeJobId;
      return [
        {
          url: "https://x.example/completed",
          title: "Completed page",
          content: "page body",
          status: "completed",
          jobId: options.resumeJobId,
        },
        {
          url: "https://x.example",
          title: "",
          content: "",
          status: "pending",
          jobId: options.resumeJobId,
        },
      ];
    },
  });

  try {
    const engine = new FanoutEngine(
      makeConfig({
        capabilities: { crawl: { providers: ["firecrawl", "exa"], strategy: "all" } },
        providers: { firecrawl: { keyPool: { keys: ["k"] } } },
      })
    );
    const out = await engine.crawl("https://x.example", {
      limit: 1,
      resumePendingJobs: [
        { provider: "firecrawl", jobId: "mixed-result-job", url: "https://x.example" },
      ],
    });

    assert.equal(resumedJobId, "mixed-result-job");
    assert.equal(out.status, "pending");
    assert.deepEqual(out.results.map((result) => result.url), ["https://x.example/completed"]);
    assert.deepEqual(out.pendingJobs, [
      { provider: "firecrawl", jobId: "mixed-result-job", url: "https://x.example" },
    ]);
  } finally {
    providerRegistry.firecrawl.createAdapter = originalCreateAdapter;
  }
});

test("a new crawl preserves completed pages returned alongside a pending handle", async () => {
  const originalCreateAdapter = providerRegistry.firecrawl.createAdapter;
  providerRegistry.firecrawl.createAdapter = () => ({
    name: "firecrawl",
    capabilities: ["crawl"],
    search: async () => [],
    crawl: async () => [
      {
        url: "https://x.example/completed",
        title: "Completed page",
        content: "page body",
        status: "completed",
        jobId: "new-mixed-job",
      },
      {
        url: "https://x.example",
        title: "",
        content: "",
        status: "pending",
        jobId: "new-mixed-job",
      },
    ],
  });

  try {
    const engine = new FanoutEngine(
      makeConfig({
        capabilities: { crawl: { providers: ["firecrawl"], strategy: "all" } },
        providers: { firecrawl: { keyPool: { keys: ["k"] } } },
      })
    );
    const out = await engine.crawl("https://x.example", { limit: 1 });

    assert.equal(out.status, "pending");
    assert.deepEqual(out.results.map((result) => result.url), ["https://x.example/completed"]);
    assert.deepEqual(out.pendingJobs, [
      { provider: "firecrawl", jobId: "new-mixed-job", url: "https://x.example" },
    ]);
  } finally {
    providerRegistry.firecrawl.createAdapter = originalCreateAdapter;
  }
});

test("saved crawl providers resume even when random selection chooses another provider", async () => {
  const originalRandom = Math.random;
  const originalSetTimeout = globalThis.setTimeout;
  Math.random = () => 0;
  globalThis.setTimeout = (fn, _delay, ...args) => originalSetTimeout(fn, 0, ...args);
  let firecrawlPolls = 0;
  const restore = installFetchMock({
    "GET https://api.firecrawl.dev/v2/crawl/saved-job": async () => {
      firecrawlPolls++;
      return jsonResponse({ success: true, status: "scraping" });
    },
    "POST https://api.exa.ai/search": async () =>
      jsonResponse({ results: [{ url: "https://x.example/a", title: "A" }] }),
    "POST https://api.exa.ai/contents": async () =>
      jsonResponse({ results: [{ url: "https://x.example/a", title: "A", text: "page" }] }),
  });

  try {
    const engine = new FanoutEngine(
      makeConfig({
        capabilities: { crawl: { providers: ["exa", "tavily"], strategy: "random" } },
        providers: { firecrawl: { keyPool: { keys: ["k"] } } },
      })
    );
    const out = await engine.crawl("https://x.example", {
      limit: 1,
      singleProvider: true,
      resumePendingJobs: [
        { provider: "firecrawl", jobId: "saved-job", url: " https://x.example " },
      ],
    });

    assert.ok(firecrawlPolls > 0, "saved provider must be resumed despite random selection");
    assert.equal(out.provider, "exa");
    assert.equal(out.status, "pending");
    assert.deepEqual(out.pendingJobs, [
      { provider: "firecrawl", jobId: "saved-job", url: "https://x.example" },
    ]);
  } finally {
    restore();
    globalThis.setTimeout = originalSetTimeout;
    Math.random = originalRandom;
  }
});

test("a saved job whose provider is no longer configured becomes an actionable non-pending error", async () => {
  const restore = installFetchMock({
    "POST https://api.exa.ai/search": async () =>
      jsonResponse({ results: [{ url: "https://x.example/a", title: "A" }] }),
    "POST https://api.exa.ai/contents": async () =>
      jsonResponse({ results: [{ url: "https://x.example/a", title: "A", text: "page" }] }),
  });

  try {
    const config = makeConfig({
      capabilities: { crawl: { providers: ["exa"], strategy: "all" } },
    });
    delete config.providers.firecrawl;
    const engine = new FanoutEngine(config);
    const out = await engine.crawl("https://x.example", {
      limit: 1,
      resumePendingJobs: [
        { provider: "firecrawl", jobId: "orphan-job", url: "https://x.example" },
      ],
    });

    assert.equal(out.status, "completed");
    assert.deepEqual(out.pendingJobs, []);
    assert.match(out.errors.firecrawl, /orphan-job.*no longer configured/);
    assert.match(out.errors.firecrawl, /Restore the provider configuration/);
  } finally {
    restore();
  }
});

test("saved Firecrawl jobs remain pending after a poll authorization failure", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, _delay, ...args) => originalSetTimeout(fn, 0, ...args);
  const restore = installFetchMock({
    "GET https://api.firecrawl.dev/v2/crawl/unauthorized-job": async () =>
      rawResponse("unauthorized", { status: 401 }),
    "POST https://api.exa.ai/search": async () =>
      jsonResponse({ results: [{ url: "https://x.example/a", title: "A" }] }),
    "POST https://api.exa.ai/contents": async () =>
      jsonResponse({ results: [{ url: "https://x.example/a", title: "A", text: "page" }] }),
  });

  try {
    const engine = new FanoutEngine(
      makeConfig({
        capabilities: { crawl: { providers: ["exa"], strategy: "all" } },
        providers: { firecrawl: { keyPool: { keys: ["k"] } } },
      })
    );
    const out = await engine.crawl("https://x.example", {
      limit: 1,
      resumePendingJobs: [
        { provider: "firecrawl", jobId: "unauthorized-job", url: "https://x.example" },
      ],
    });

    assert.equal(out.status, "pending");
    assert.deepEqual(out.pendingJobs, [
      { provider: "firecrawl", jobId: "unauthorized-job", url: "https://x.example" },
    ]);
    assert.match(out.errors.firecrawl, /unauthorized-job/);
  } finally {
    restore();
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("provider default Exa result count survives an implicit CLI limit", async () => {
  const seen = [];
  const restore = installFetchMock({
    "POST https://api.exa.ai/search": async ({ init }) => {
      seen.push(JSON.parse(init.body).numResults);
      return jsonResponse({ results: [] });
    },
  });

  try {
    const engine = new FanoutEngine(
      makeConfig({
        capabilities: { search: { providers: ["exa"], strategy: "all" } },
        providers: { exa: { keyPool: { keys: ["k"] }, options: { numResults: 4 } } },
      })
    );
    await engine.search("implicit", { limit: 10, limitSet: false });
    await engine.search("explicit", { limit: 7, limitSet: true });
    assert.deepEqual(seen, [4, 7]);
  } finally {
    restore();
  }
});

