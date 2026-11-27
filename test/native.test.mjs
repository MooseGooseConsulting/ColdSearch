import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  GatewayCore,
  HostGate,
  createGatewayServer,
  needsFallback,
  parseRobots,
  parseSitemap,
  readHtml,
  resolveGatewayConfig,
  validateFetchUrl,
} from "../dist/index.js";

// --- a local site ------------------------------------------------------------

/**
 * A site on 127.0.0.1. `routes` maps "host/path" (or "/path" for any host) to
 * a reply: a string (an HTML page), or { status, type, body, headers }.
 * `events` records every request in arrival order, and `maxInflight` the most
 * requests the site ever served at once.
 */
async function startSite(routes) {
  const site = { events: [], maxInflight: 0, port: 0, close: undefined };
  let inflight = 0;
  const server = createServer((req, res) => {
    inflight++;
    site.maxInflight = Math.max(site.maxInflight, inflight);
    const host = req.headers.host.split(":")[0];
    site.events.push(`GET ${host}${req.url}`);
    res.on("finish", () => inflight--);
    const found = routes[`${host}${req.url}`] ?? routes[req.url];
    const reply = typeof found === "string" ? { body: found } : found ?? { status: 404, body: "<h1>Not found</h1>" };
    // Answer a little later, so two requests in flight at once would overlap and be counted.
    setTimeout(() => {
      res.writeHead(reply.status ?? 200, { "Content-Type": reply.type ?? "text/html; charset=utf-8", ...reply.headers });
      res.end(reply.body ?? "");
    }, 3);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  site.port = server.address().port;
  site.close = () => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  };
  site.url = (pathname, host = "site.test") => `http://${host}:${site.port}${pathname}`;
  site.requests = () => site.events.filter((event) => event.startsWith("GET "));
  return site;
}

/** Names the tests' fake DNS knows. Everything else under .test is the local site. */
const INTERNAL_HOST = "internal.test";

/**
 * A gateway whose native tools may reach the local site. This is the test-only
 * way past the SSRF guard: `lookup` gives the local server realistic
 * hostnames, and `unsafeAllowAddress` lets exactly 127.0.0.1 through. `clock`
 * replaces time, so the politeness pause is recorded instead of waited for.
 */
function makeGateway({ native = {}, upstreams, calls = [], paid, production = false, site, mode } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "cs-native-"));
  const clock = { now: Date.parse("2026-11-27T12:00:00Z") };
  const hooks = {
    lookup: async (host) => [{ address: host === INTERNAL_HOST ? "10.0.0.5" : "127.0.0.1", family: 4 }],
    unsafeAllowAddress: (address) => address === "127.0.0.1",
    sleep: async (ms) => {
      site?.events.push(`sleep ${ms}`);
      clock.now += ms;
    },
  };
  const config = resolveGatewayConfig({
    ledger: path.join(dir, "ledger.jsonl"),
    state: path.join(dir, "state.json"),
    skills_dir: path.join(dir, "skills"),
    ...(mode ? { mode } : {}),
    upstreams: upstreams ?? { paid: { url: "https://paid.example.com/mcp", keys: ["env:PAID_KEY"] } },
    native,
  });
  const connector = async () => ({
    listTools: async () => ({ tools: [{ name: "scrape", description: "Scrape one URL", inputSchema: { type: "object" } }] }),
    callTool: async ({ name, arguments: args }) => {
      calls.push({ name, args });
      return paid ? paid(args) : { content: [{ type: "text", text: JSON.stringify({ data: { markdown: `# Paid copy of ${args.url}`, metadata: { title: "Paid title" } } }) }] };
    },
    close: async () => undefined,
  });
  const core = new GatewayCore(config, {
    connector,
    resolveKey: async () => "paid-key-value-000000",
    now: () => clock.now,
    ...(production ? {} : { native: hooks }),
  });
  const ledger = () => readFileSync(path.join(dir, "ledger.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  return { core, dir, ledger, calls, clock };
}

const ctx = { session: "s1", client: "test/1.0" };
const meta = (result) => JSON.parse(result.content[0].text);

const ARTICLE = `<!doctype html>
<html><head><title>Install guide &amp; notes</title><style>p { color: red }</style></head>
<body>
<nav><a href="/">Home</a> <a href="/docs/a#intro">Docs</a></nav>
<main>
<h1>Install guide</h1>
<p>Run <code>npm install</code>, then read the <a href="../start?x=1">start <b>page</b></a>.<br>It takes 2 * 3 minutes.
<h2>Steps</h2>
<ul><li>Download<li>Unpack <em>carefully</em><ul><li>Check the hash</li></ul></li></ul>
<ol start="3"><li>Build</li><li>Run</li></ol>
<pre><code class="language-js">const greeting = "hi";
if (greeting) { console.log(greeting); }
</code></pre>
<blockquote><p>Measure twice.</p></blockquote>
<table><tr><th>Plan</th><th>Pages</th></tr><tr><td>Free | trial</td><td>500</td></tr></table>
<script>document.write("<p>injected</p>")</script>
<p>- not a list item</p>
</main>
<footer>Site footer</footer>
</body></html>`;

const ARTICLE_MARKDOWN = `# Install guide

Run \`npm install\`, then read the [start **page**](http://site.test:PORT/start?x=1).
It takes 2 \\* 3 minutes.

## Steps

- Download
- Unpack *carefully*
  - Check the hash

3. Build
4. Run

\`\`\`js
const greeting = "hi";
if (greeting) { console.log(greeting); }
\`\`\`

> Measure twice.

| Plan | Pages |
| --- | --- |
| Free \\| trial | 500 |

\\- not a list item`;

// --- fetch -------------------------------------------------------------------

test("coldsearch_fetch turns a page into markdown: headings, links, lists, code, tables kept; scripts, styles and navigation dropped", async () => {
  const site = await startSite({
    "/guide/install": { body: gzipSync(ARTICLE), headers: { "Content-Encoding": "gzip" } },
  });
  try {
    const { core, ledger, calls } = makeGateway({ site });
    const result = await core.native.call("coldsearch_fetch", { url: site.url("/guide/install") }, ctx);

    assert.equal(result.isError, undefined);
    assert.deepEqual(meta(result), {
      url: site.url("/guide/install"),
      status: 200,
      source: "direct",
      title: "Install guide & notes",
      format: "markdown",
      chars: ARTICLE_MARKDOWN.replace("PORT", site.port).length,
      truncated: false,
    });
    assert.equal(result.content[1].text, ARTICLE_MARKDOWN.replace("PORT", site.port));
    assert.equal(calls.length, 0, "a readable page never reaches a provider");

    const text = await core.native.call("coldsearch_fetch", { url: site.url("/guide/install"), format: "text", max_chars: 40 }, ctx);
    assert.equal(text.content[1].text, "Install guide\n\nRun npm install, then rea");
    assert.equal(meta(text).truncated, true);

    const html = await core.native.call("coldsearch_fetch", { url: site.url("/guide/install"), format: "html" }, ctx);
    assert.equal(html.content[1].text, ARTICLE);

    const [entry] = ledger();
    assert.deepEqual(
      { upstream: entry.upstream, tool: entry.tool, key: entry.key, ok: entry.ok, pages: entry.pages, client: entry.client },
      { upstream: "coldsearch", tool: "coldsearch_fetch", key: "coldsearch:keyless", ok: true, pages: 1, client: "test/1.0" }
    );
    assert.equal(typeof entry.duration_ms, "number");
    assert.match(entry.args, /guide\/install/);
  } finally {
    await site.close();
  }
});

test("the HTML reader survives markup browsers tolerate and resolves links against <base>", () => {
  const page = readHtml(
    `<base href="https://cdn.example.com/v2/"><p>Unclosed <b>bold <a href="page">link</a>
     <table><tr><td><table><tr><td>layout</td></tr></table></td></tr></table>
     <a href="javascript:void(0)">script link</a><a href="mailto:someone@example.com">mail</a><a href="#top">top</a>`,
    "https://example.com/dir/index.html"
  );
  assert.deepEqual(page.links, ["https://cdn.example.com/v2/page", "https://cdn.example.com/v2/"]);
  assert.match(page.markdown(), /^Unclosed \*\*bold \[link\]\(https:\/\/cdn\.example\.com\/v2\/page\)/);
  assert.match(page.markdown(), /layout/, "a layout table's cells are read as ordinary content");
  assert.doesNotMatch(page.markdown(), /javascript:/);
  assert.match(page.markdown(), /\[mail\]\(mailto:someone@example\.com\)/);

  const anchors = readHtml(
    `<h2 id="setup">Setup<a class="headerlink" href="#setup">¶</a></h2><p>See <a href="#usage">Usage</a> or <a href="/other#usage">the other page</a>.</p>`,
    "https://example.com/guide"
  );
  assert.equal(anchors.markdown(), "## Setup\n\nSee Usage or [the other page](https://example.com/other#usage).", "same-page anchors are words, not links");

  const deep = readHtml("<div>".repeat(5000) + "bottom" + "</div>".repeat(5000), "https://example.com/");
  assert.equal(deep.markdown(), "bottom", "deep nesting is flattened, not a stack overflow");
});

test("a page the gateway cannot read is flagged needs_fallback with the reason; a missing page is not", async () => {
  const shell = `<!doctype html><html><head><title>App</title></head><body><div id="root"></div><noscript>You need to enable JavaScript to run this app.</noscript><script src="/bundle.js"></script></body></html>`;
  const challenge = `<!doctype html><html><head><title>Just a moment...</title></head><body><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script><p>Checking your browser.</p></body></html>`;
  const site = await startSite({
    "/forbidden": { status: 403, body: "<h1>Forbidden</h1>" },
    "/busy": { status: 429, body: "slow down", type: "text/plain" },
    "/broken": { status: 503, body: "<h1>Unavailable</h1>" },
    "/app": shell,
    "/challenge": challenge,
    "/gone": { status: 404, body: "<h1>No such page</h1>" },
    "/report.pdf": { type: "application/pdf", body: "%PDF-1.7" },
  });
  try {
    const { core, ledger, calls } = makeGateway({ site, native: { fallback: "paid__scrape" } });
    const reasons = {};
    for (const name of ["forbidden", "busy", "broken", "app", "challenge"]) {
      const result = await core.native.call("coldsearch_fetch", { url: site.url(`/${name}`) }, ctx);
      assert.equal(result.isError, true, name);
      const info = meta(result);
      assert.equal(info.needs_fallback, true, name);
      assert.match(info.next, /allow_paid_fallback: true.*paid__scrape/, "the result says how to get the page");
      reasons[name] = info.reason;
    }
    assert.deepEqual(reasons, { forbidden: "http_403", busy: "http_429", broken: "http_503", app: "no_text", challenge: "challenge_page" });

    const gone = meta(await core.native.call("coldsearch_fetch", { url: site.url("/gone") }, ctx));
    assert.equal(gone.error, "http_404");
    assert.equal(gone.needs_fallback, undefined, "paying a provider for a 404 buys the same 404");
    const pdf = meta(await core.native.call("coldsearch_fetch", { url: site.url("/report.pdf") }, ctx));
    assert.equal(pdf.error, "unsupported_content_type");

    assert.equal(calls.length, 0, "nothing is bought unless the agent allows it");
    const entries = ledger();
    assert.equal(entries.length, 7);
    assert.ok(entries.every((entry) => entry.upstream === "coldsearch" && entry.ok === false && entry.error_class === "gateway"));
    assert.match(entries[0].error, /needs_fallback http_403/);
  } finally {
    await site.close();
  }
});

test("the fallback detector does not mistake an ordinary page for a wall", () => {
  const html = (body) => ({ textChars: readHtml(body, "https://example.com/").textChars, emptyAppRoot: false, noscriptAsksForJavascript: false });
  const prose = "<p>" + "Real content. ".repeat(200) + "</p>";

  // Cloudflare adds its script to pages it serves normally; with real text around it, that is a page.
  const proxied = `<html><body>${prose}<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script></body></html>`;
  assert.equal(needsFallback({ status: 200, headers: {}, body: proxied, html: html(proxied) }), undefined);

  // A short page is a short page, not an empty shell.
  const short = "<html><body><p>It works.</p></body></html>";
  assert.equal(needsFallback({ status: 200, headers: {}, body: short, html: html(short) }), undefined);

  // A large document with no text is a shell even without a marker.
  const hollow = `<html><body><div class="x"></div>${"<!-- padding -->".repeat(500)}</body></html>`;
  assert.equal(needsFallback({ status: 200, headers: {}, body: hollow, html: html(hollow) })?.reason, "no_text");

  // The header alone is enough, whatever the status and body say.
  assert.equal(needsFallback({ status: 200, headers: { "cf-mitigated": "challenge" }, body: prose, html: html(prose) })?.reason, "challenge_page");
});

test("with allow_paid_fallback the page comes through the configured tool, marked paid, even when that tool is hidden from agents", async () => {
  const site = await startSite({ "/forbidden": { status: 403, body: "<h1>Forbidden</h1>" } });
  try {
    const { core, ledger, calls } = makeGateway({
      site,
      upstreams: { paid: { url: "https://paid.example.com/mcp", keys: ["env:PAID_KEY"], exclude: ["scrape"] } },
      native: { fallback: "paid__scrape", fallback_arguments: { url: "{url}", formats: ["markdown"], options: { tag: "from {url}" } } },
    });
    const url = site.url("/forbidden");

    const hidden = await core.callTool("paid__scrape", { url }, ctx);
    assert.match(hidden.content[0].text, /not offered by this gateway/, "an agent still cannot call the hidden tool");

    const result = await core.native.call("coldsearch_fetch", { url, allow_paid_fallback: true }, ctx);
    assert.equal(result.isError, undefined);
    const info = meta(result);
    assert.deepEqual(
      { source: info.source, paid_tool: info.paid_tool, direct_problem: info.direct_problem, title: info.title },
      { source: "paid", paid_tool: "paid__scrape", direct_problem: "http_403", title: "Paid title" }
    );
    assert.equal(result.content[1].text, `# Paid copy of ${url}`);
    assert.deepEqual(calls, [{ name: "scrape", args: { url, formats: ["markdown"], options: { tag: `from ${url}` } } }]);

    // The provider call is in the ledger under its own upstream and key; the native call beside it read no page itself.
    const [bought, native] = ledger();
    assert.deepEqual({ upstream: bought.upstream, tool: bought.tool, key: bought.key, ok: bought.ok }, { upstream: "paid", tool: "scrape", key: "env:PAID_KEY", ok: true });
    assert.deepEqual({ upstream: native.upstream, ok: native.ok, pages: native.pages }, { upstream: "coldsearch", ok: true, pages: 0 });
  } finally {
    await site.close();
  }
});

test("a paid fallback that fails is reported as a failure, not passed off as the page", async () => {
  const site = await startSite({ "/forbidden": { status: 403, body: "<h1>Forbidden</h1>" } });
  try {
    const { core } = makeGateway({
      site,
      native: { fallback: "paid__scrape" },
      paid: async () => ({ content: [{ type: "text", text: JSON.stringify({ error: "blocked by site", status: 500 }) }] }),
    });
    const result = await core.native.call("coldsearch_fetch", { url: site.url("/forbidden"), allow_paid_fallback: true }, ctx);
    assert.equal(result.isError, true);
    assert.match(meta(result).paid_fallback_error, /paid__scrape returned no page content/);
    assert.equal(result.content.length, 1);
  } finally {
    await site.close();
  }
});

test("a body past the 5 MiB cap is cut and marked truncated, counted after decompression", async () => {
  const huge = `<p>${"word ".repeat(1_300_000)}</p>`;
  const site = await startSite({ "/huge": { body: gzipSync(huge), headers: { "Content-Encoding": "gzip" } } });
  try {
    const { core } = makeGateway({ site });
    const result = await core.native.call("coldsearch_fetch", { url: site.url("/huge"), format: "html", max_chars: 5_000_000 }, ctx);
    assert.equal(result.isError, undefined);
    assert.equal(meta(result).truncated, true);
    assert.equal(meta(result).chars, 5 * 1024 * 1024, "a small compressed body cannot expand past the cap");
  } finally {
    await site.close();
  }
});

// --- SSRF --------------------------------------------------------------------

test("in production the SSRF guard refuses private addresses before any request, and every redirect hop is checked again", async () => {
  const site = await startSite({
    "/": "<p>" + "Local page. ".repeat(50) + "</p>",
    "/moved": { status: 302, headers: { Location: "/landing" } },
    "/landing": "<p>" + "Landed. ".repeat(50) + "</p>",
    "/to-internal": { status: 302, headers: { Location: `http://${INTERNAL_HOST}/admin` } },
    "/to-metadata": { status: 301, headers: { Location: "http://169.254.169.254/latest/meta-data/" } },
  });
  try {
    // No test hooks: this is the gateway as `coldsearch mcp` builds it.
    const production = makeGateway({ production: true });
    for (const url of [`http://127.0.0.1:${site.port}/`, "http://localhost/", "http://10.0.0.5/", "http://[::1]/", "http://169.254.169.254/latest/meta-data/"]) {
      const result = await production.core.native.call("coldsearch_fetch", { url }, ctx);
      assert.equal(result.isError, true, url);
      assert.match(result.content[0].text, /Refusing to fetch/, url);
      for (const tool of ["coldsearch_crawl", "coldsearch_map"]) {
        const refused = await production.core.native.call(tool, { url }, ctx);
        assert.equal(refused.isError, true, `${tool} ${url}`);
        assert.match(refused.content[0].text, /Refusing to fetch/, `${tool} ${url}`);
      }
    }
    assert.deepEqual(site.requests(), [], "nothing reached the loopback server");
    assert.equal(production.ledger().length, 15, "refused calls are in the ledger too");
    await assert.rejects(validateFetchUrl("file:///etc/passwd"), /Unsupported fetch URL protocol/);

    // With the test allowance for 127.0.0.1, the rest of the guard still stands.
    const { core } = makeGateway({ site });
    const followed = await core.native.call("coldsearch_fetch", { url: site.url("/moved") }, ctx);
    assert.equal(meta(followed).final_url, site.url("/landing"));
    assert.match(followed.content[1].text, /^Landed\./);

    for (const pathname of ["/to-internal", "/to-metadata"]) {
      const refused = await core.native.call("coldsearch_fetch", { url: site.url(pathname) }, ctx);
      assert.equal(refused.isError, true, pathname);
      assert.match(refused.content[0].text, /Refusing to fetch/, pathname);
    }
    const localhost = await core.native.call("coldsearch_fetch", { url: `http://localhost:${site.port}/` }, ctx);
    assert.match(localhost.content[0].text, /Refusing to fetch internal hostname/);
  } finally {
    await site.close();
  }
});

// --- robots and sitemaps -----------------------------------------------------

test("robots.txt rules: the gateway's own group wins over *, the longest rule decides, Allow wins a tie", () => {
  const url = (pathname) => new URL(`https://example.com${pathname}`);
  const general = parseRobots(
    `# comment
User-agent: *
Disallow: /private/
Allow: /private/press/
Disallow: /*.json$
Disallow: /tie
Allow: /tie
Disallow:

Sitemap: https://example.com/sitemap.xml
User-agent: otherbot
Disallow: /
Sitemap: https://example.com/news.xml`,
    "coldsearch"
  );
  assert.equal(general.allowed(url("/")), true);
  assert.equal(general.allowed(url("/private/x")), false);
  assert.equal(general.allowed(url("/private/press/2026")), true);
  assert.equal(general.allowed(url("/data.json")), false);
  assert.equal(general.allowed(url("/data.json?download=1")), true, "$ anchors the end of path and query");
  assert.equal(general.allowed(url("/tie")), true);
  assert.deepEqual(general.sitemaps, ["https://example.com/sitemap.xml", "https://example.com/news.xml"]);

  const named = parseRobots("User-agent: *\nDisallow: /\n\nUser-agent: Googlebot\nUser-agent: ColdSearch\nDisallow: /search\n", "coldsearch");
  assert.equal(named.allowed(url("/docs")), true, "the group naming this crawler replaces the * group");
  assert.equal(named.allowed(url("/search?q=x")), false);

  assert.equal(parseRobots("", "coldsearch").allowed(url("/anything")), true);
});

test("sitemap files: page lists, indexes, CDATA, entities and the plain-text form", () => {
  assert.deepEqual(
    parseSitemap(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
      <url><loc> https://example.com/a?x=1&amp;y=2 </loc><image:image><image:loc>https://example.com/a.png</image:loc></image:image></url>
      <url><loc><![CDATA[https://example.com/b]]></loc><lastmod>2026-11-01</lastmod></url></urlset>`),
    { kind: "urlset", locs: ["https://example.com/a?x=1&y=2", "https://example.com/b"] }
  );
  assert.deepEqual(
    parseSitemap(`<sitemapindex><sitemap><loc>https://example.com/s1.xml</loc></sitemap><sitemap><loc>https://example.com/s2.xml.gz</loc></sitemap></sitemapindex>`),
    { kind: "index", locs: ["https://example.com/s1.xml", "https://example.com/s2.xml.gz"] }
  );
  assert.deepEqual(parseSitemap("https://example.com/one\nhttps://example.com/two\nnot a url\n"), {
    kind: "urlset",
    locs: ["https://example.com/one", "https://example.com/two"],
  });
});

test("coldsearch_map reads robots.txt, a sitemap index, a nested index and a .gz sitemap, and returns same-site URLs once each", async () => {
  // The sitemaps name the site's own port, so the routes are filled in once the site is listening.
  const routes = {};
  const site = await startSite(routes);
  const u = site.url;
  const urlset = (locs) => `<?xml version="1.0"?><urlset>${locs.map((loc) => `<url><loc>${loc}</loc></url>`).join("")}</urlset>`;
  const index = (locs) => `<?xml version="1.0"?><sitemapindex>${locs.map((loc) => `<sitemap><loc>${loc}</loc></sitemap>`).join("")}</sitemapindex>`;
  Object.assign(routes, {
    "/robots.txt": { type: "text/plain", body: `User-agent: *\nDisallow: /private/\nSitemap: ${u("/sitemap-index.xml")}\n` },
    "/sitemap-index.xml": { type: "application/xml", body: index([u("/sitemap-pages.xml"), u("/nested-index.xml"), u("/missing.xml")]) },
    "/sitemap-pages.xml": { type: "application/xml", body: urlset([u("/"), u("/docs/a"), u("/docs/b#section"), "https://elsewhere.example.com/x"]) },
    // The nested index lists the top index again; a careless reader would loop.
    "/nested-index.xml": { type: "application/xml", body: index([u("/sitemap-blog.xml.gz"), u("/sitemap-index.xml")]) },
    "/sitemap-blog.xml.gz": {
      type: "application/gzip",
      body: gzipSync(urlset([u("/blog/1"), u("/docs/a"), u("/guide", "docs.site.test"), u("/", "www.site.test")])),
    },
  });
  try {
    const { core, ledger, calls } = makeGateway({ site });
    const result = await core.native.call("coldsearch_map", { url: u("/docs/a") }, ctx);
    assert.equal(result.isError, undefined);
    const map = meta(result);
    assert.equal(map.source, "sitemap");
    assert.deepEqual(map.urls, [u("/"), u("/docs/a"), u("/docs/b"), u("/blog/1"), u("/", "www.site.test")]);
    assert.equal(map.truncated, false);
    assert.deepEqual(map.sitemaps, [u("/sitemap-index.xml"), u("/sitemap-pages.xml"), u("/nested-index.xml"), u("/sitemap-blog.xml.gz")]);
    assert.equal(calls.length, 0, "map never calls a provider");
    assert.equal(site.requests().filter((event) => event.endsWith("/sitemap-index.xml")).length, 1, "an index that lists itself is read once");
    assert.ok(!site.requests().some((event) => event.endsWith("/docs/a")), "with a sitemap, the page itself is not fetched");

    const withSubdomains = meta(await core.native.call("coldsearch_map", { url: u("/"), include_subdomains: true }, ctx));
    assert.ok(withSubdomains.urls.includes(u("/guide", "docs.site.test")));

    const limited = meta(await core.native.call("coldsearch_map", { url: u("/"), limit: 2 }, ctx));
    assert.deepEqual(limited.urls, [u("/"), u("/docs/a")]);
    assert.equal(limited.truncated, true);

    const entry = ledger()[0];
    assert.deepEqual({ upstream: entry.upstream, tool: entry.tool, key: entry.key, ok: entry.ok }, { upstream: "coldsearch", tool: "coldsearch_map", key: "coldsearch:keyless", ok: true });
  } finally {
    await site.close();
  }
});

test("coldsearch_map falls back to one fetch of the page for same-site links when the site has no sitemap", async () => {
  const site = await startSite({
    "/start": `<p>${"Welcome. ".repeat(40)}</p><a href="/a">A</a> <a href="b?x=1#frag">B</a> <a href="/a">A again</a> <a href="https://elsewhere.example.com/">Out</a> <a href="mailto:someone@example.com">Mail</a>`,
  });
  try {
    const { core, calls } = makeGateway({ site });
    const map = meta(await core.native.call("coldsearch_map", { url: site.url("/start") }, ctx));
    assert.equal(map.source, "links");
    assert.deepEqual(map.urls, [site.url("/start"), site.url("/a"), site.url("/b?x=1")]);
    assert.deepEqual(site.requests(), ["GET site.test/robots.txt", "GET site.test/sitemap.xml", "GET site.test/start"]);
    assert.equal(calls.length, 0);
  } finally {
    await site.close();
  }
});

// --- crawl -------------------------------------------------------------------

const page = (title, links = []) =>
  `<html><head><title>${title}</title></head><body><h1>${title}</h1><p>${`${title} body text. `.repeat(30)}</p>${links.map((href) => `<a href="${href}">${href}</a>`).join(" ")}</body></html>`;

function crawlSite() {
  return startSite({
    "/robots.txt": { type: "text/plain", body: "User-agent: *\nDisallow: /private/\n\nUser-agent: coldsearch\nDisallow: /private/\nDisallow: /admin\n" },
    "/": page("Home", ["/a", "/b", "/docs/x", "/private/secret", "/admin", "/blog/1", "/logo.png", "https://elsewhere.example.com/", "/a#top", "/old"]),
    "/a": page("A", ["/a/deep", "/"]),
    "/b": page("B", ["/a", "/missing"]),
    "/docs/x": page("Docs X", ["/docs/y"]),
    "/docs/y": page("Docs Y"),
    "/blog/1": page("Blog 1"),
    "/a/deep": page("Deep", ["/a/deep/deeper"]),
    "/a/deep/deeper": page("Deeper"),
    "/old": { status: 301, headers: { Location: "/a" } },
    "/private/secret": page("Secret"),
    "/admin": page("Admin"),
  });
}

test("coldsearch_crawl goes breadth-first over same-site links, obeys robots.txt, depth and path patterns, and reports what it skipped", async () => {
  const site = await crawlSite();
  try {
    const { core, ledger, calls } = makeGateway({ site });
    const result = await core.native.call("coldsearch_crawl", { url: site.url("/"), max_depth: 2, exclude: ["/blog/*"] }, ctx);
    assert.equal(result.isError, undefined);
    const crawl = meta(result);

    assert.deepEqual(
      crawl.pages.map((entry) => [new URL(entry.url).pathname, entry.title, entry.source]),
      [["/", "Home", "direct"], ["/a", "A", "direct"], ["/b", "B", "direct"], ["/docs/x", "Docs X", "direct"], ["/a/deep", "Deep", "direct"], ["/docs/y", "Docs Y", "direct"]],
      "start page, then its links in page order, then theirs; /a/deep/deeper is three links away"
    );
    assert.match(crawl.pages[1].markdown, /^# A\n\nA body text\./);
    assert.deepEqual(
      crawl.skipped.map((entry) => [new URL(entry.url).pathname, entry.reason]),
      [["/private/secret", "robots_disallowed"], ["/admin", "robots_disallowed"], ["/missing", "http_404"]]
    );
    assert.deepEqual(
      { requested: crawl.stats.requested, direct: crawl.stats.direct, paid: crawl.stats.paid, stopped: crawl.stats.stopped, depth_reached: crawl.stats.depth_reached, filtered_links: crawl.stats.filtered_links },
      // 6 pages, the redirect from /old (which lands on /a, already read) and the 404; /blog/1 and /logo.png were never requested.
      { requested: 8, direct: 6, paid: 0, stopped: "done", depth_reached: 2, filtered_links: 2 }
    );
    const requested = site.requests();
    assert.ok(!requested.some((event) => /private|admin|blog|logo|elsewhere/.test(event)), "disallowed, excluded and off-site URLs are never requested");
    assert.equal(requested.filter((event) => event.endsWith("/robots.txt")).length, 1, "robots.txt is read once per site");
    assert.equal(calls.length, 0);

    const entry = ledger()[0];
    assert.deepEqual(
      { upstream: entry.upstream, tool: entry.tool, key: entry.key, ok: entry.ok, pages: entry.pages },
      { upstream: "coldsearch", tool: "coldsearch_crawl", key: "coldsearch:keyless", ok: true, pages: 6 }
    );
  } finally {
    await site.close();
  }
});

test("coldsearch_crawl stops at limit, and include narrows which links are followed", async () => {
  const site = await crawlSite();
  try {
    const { core } = makeGateway({ site });
    const limited = meta(await core.native.call("coldsearch_crawl", { url: site.url("/"), limit: 3 }, ctx));
    assert.deepEqual(limited.pages.map((entry) => new URL(entry.url).pathname), ["/", "/a", "/b"]);
    assert.deepEqual({ requested: limited.stats.requested, stopped: limited.stats.stopped }, { requested: 3, stopped: "limit" });

    const docsOnly = meta(await core.native.call("coldsearch_crawl", { url: site.url("/"), include: ["/docs/*"] }, ctx));
    assert.deepEqual(docsOnly.pages.map((entry) => new URL(entry.url).pathname), ["/", "/docs/x", "/docs/y"], "the start URL is read even though it is outside include");

    const startOnly = meta(await core.native.call("coldsearch_crawl", { url: site.url("/"), max_depth: 0 }, ctx));
    assert.deepEqual(startOnly.pages.map((entry) => new URL(entry.url).pathname), ["/"]);

    const capped = meta(await core.native.call("coldsearch_crawl", { url: site.url("/"), limit: 100000, max_chars_per_page: 10 }, ctx));
    assert.equal(capped.stats.limit, 500, "limit has a hard maximum of 500");
    assert.deepEqual({ markdown: capped.pages[0].markdown, truncated: capped.pages[0].truncated }, { markdown: "# Home\n\nHo", truncated: true });

    const bad = await core.native.call("coldsearch_crawl", { url: site.url("/"), max_depth: "two" }, ctx);
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /coldsearch_crawl: max_depth must be a whole number/);
    const noUrl = await core.native.call("coldsearch_crawl", { url: "ftp://example.com/" }, ctx);
    assert.match(noUrl.content[0].text, /coldsearch_crawl: url must be an http or https URL/);
  } finally {
    await site.close();
  }
});

test("a crawl makes one request at a time and pauses delay_ms between requests to a host", async () => {
  const site = await crawlSite();
  try {
    const { core } = makeGateway({ site, native: { delay_ms: 750 } });
    const [first, second] = await Promise.all([
      core.native.call("coldsearch_crawl", { url: site.url("/"), limit: 4 }, ctx),
      // A second agent on the same host shares the gate; it does not double the request rate.
      core.native.call("coldsearch_fetch", { url: site.url("/docs/y") }, ctx),
    ]);
    assert.equal(first.isError, undefined);
    assert.equal(second.isError, undefined);

    assert.equal(site.maxInflight, 1, "never two requests in flight");
    const requests = site.requests().length;
    assert.equal(requests, 6, "robots.txt, four pages, and the other agent's fetch");
    // On the test clock a request takes no time, so each one after the first must be preceded by the whole pause.
    assert.deepEqual(
      site.events.map((event) => event.split(" ")[0]),
      Array.from({ length: requests * 2 - 1 }, (_, index) => (index % 2 === 0 ? "GET" : "sleep"))
    );
    assert.ok(site.events.filter((event) => event.startsWith("sleep")).every((event) => event === "sleep 750"));
  } finally {
    await site.close();
  }
});

test("the host gate keeps one host's requests in order and does not make another host wait", async () => {
  let now = 0;
  const log = [];
  const gate = new HostGate(100, () => now, async (ms) => {
    log.push(`sleep ${ms}`);
    now += ms;
  });
  const task = (name, cost) => async () => {
    log.push(`start ${name}`);
    await new Promise((resolve) => setImmediate(resolve));
    now += cost;
    log.push(`end ${name}`);
  };
  await Promise.all([
    gate.run("a.example.com", task("a1", 30)),
    gate.run("a.example.com", task("a2", 0)),
    gate.run("b.example.com", task("b1", 0)),
  ]);
  assert.deepEqual(log.filter((line) => /a\d|sleep/.test(line)), ["start a1", "end a1", "sleep 100", "start a2", "end a2"]);
  assert.ok(log.indexOf("start b1") < log.indexOf("end a1"), "host b started while host a was busy");

  // The pause is measured from the end of the previous request: time already spent counts toward it.
  now += 60;
  await gate.run("a.example.com", task("a3", 0));
  assert.equal(log.at(-3), "sleep 40");
});

test("in a crawl, pages that need fallback are skipped unless paid fallback is allowed, and then only max_paid_pages of them are bought", async () => {
  const shell = `<html><head><title>App</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>`;
  const routes = {
    "/": page("Home", ["/s1", "/s2", "/ok", "/s3", "/s4"]),
    "/ok": page("Readable"),
    "/s1": shell,
    "/s2": shell,
    "/s3": shell,
    "/s4": shell,
  };
  const site = await startSite(routes);
  try {
    const free = makeGateway({ site, native: { fallback: "paid__scrape", max_paid_pages: 2 } });
    const unpaid = meta(await free.core.native.call("coldsearch_crawl", { url: site.url("/") }, ctx));
    assert.deepEqual(unpaid.pages.map((entry) => new URL(entry.url).pathname), ["/", "/ok"]);
    assert.deepEqual(unpaid.skipped.map((entry) => [new URL(entry.url).pathname, entry.reason]), [["/s1", "needs_fallback"], ["/s2", "needs_fallback"], ["/s3", "needs_fallback"], ["/s4", "needs_fallback"]]);
    assert.match(unpaid.skipped[0].detail, /^no_text: /);
    assert.equal(free.calls.length, 0);

    const { core, calls, ledger } = makeGateway({ site, native: { fallback: "paid__scrape", max_paid_pages: 2 } });
    const crawl = meta(await core.native.call("coldsearch_crawl", { url: site.url("/"), allow_paid_fallback: true }, ctx));
    assert.deepEqual(
      crawl.pages.map((entry) => [new URL(entry.url).pathname, entry.source]),
      [["/", "direct"], ["/s1", "paid"], ["/s2", "paid"], ["/ok", "direct"]]
    );
    assert.equal(crawl.pages[1].markdown, `# Paid copy of ${site.url("/s1")}`);
    assert.deepEqual(crawl.skipped.map((entry) => [new URL(entry.url).pathname, entry.reason]), [["/s3", "paid_cap_reached"], ["/s4", "paid_cap_reached"]]);
    assert.deepEqual(calls.map((call) => call.args.url), [site.url("/s1"), site.url("/s2")], "the cap is on calls made, not pages returned");
    assert.deepEqual({ direct: crawl.stats.direct, paid: crawl.stats.paid, paid_attempts: crawl.stats.paid_attempts }, { direct: 2, paid: 2, paid_attempts: 2 });

    const entries = ledger();
    assert.deepEqual(entries.map((entry) => [entry.upstream, entry.tool, entry.key]), [
      ["paid", "scrape", "env:PAID_KEY"],
      ["paid", "scrape", "env:PAID_KEY"],
      ["coldsearch", "coldsearch_crawl", "coldsearch:keyless"],
    ]);
    assert.equal(entries[2].pages, 2, "the ledger counts only the pages read without a provider");
  } finally {
    await site.close();
  }
});

test("a crawl stops asking a site that refuses it three times in a row, and never buys a robots-disallowed page", async () => {
  const refused = { status: 403, body: "<h1>Forbidden</h1>" };
  const site = await startSite({
    "/robots.txt": { type: "text/plain", body: "User-agent: *\nDisallow: /private/\n" },
    "/": page("Home", ["/private/x", "/x1", "/x2", "/x3", "/x4", "/x5"]),
    "/x1": refused,
    "/x2": refused,
    "/x3": refused,
    "/x4": refused,
    "/x5": refused,
  });
  try {
    const { core, calls } = makeGateway({ site, native: { fallback: "paid__scrape" } });
    const crawl = meta(await core.native.call("coldsearch_crawl", { url: site.url("/"), allow_paid_fallback: true }, ctx));
    assert.deepEqual({ requested: crawl.stats.requested, stopped: crawl.stats.stopped }, { requested: 4, stopped: "site_protected" });
    assert.deepEqual(calls.map((call) => new URL(call.args.url).pathname), ["/x1", "/x2", "/x3"]);
    assert.deepEqual(crawl.skipped, [{ url: site.url("/private/x"), reason: "robots_disallowed" }]);
    assert.ok(!site.requests().some((event) => /x4|x5|private/.test(event)));
  } finally {
    await site.close();
  }
});

test("a site whose robots.txt cannot be read is not crawled", async () => {
  const site = await startSite({ "/robots.txt": { status: 503, body: "down" }, "/": page("Home") });
  try {
    const { core } = makeGateway({ site });
    const result = await core.native.call("coldsearch_crawl", { url: site.url("/") }, ctx);
    assert.equal(result.isError, true);
    assert.deepEqual(meta(result).skipped, [{ url: site.url("/"), reason: "robots_unreachable" }]);
    assert.deepEqual(site.requests(), ["GET site.test/robots.txt"]);
  } finally {
    await site.close();
  }
});

// --- ledger, status, MCP surface ----------------------------------------------

test("native calls leave a ledger line and a payload file like upstream calls, and show up in status", async () => {
  const site = await startSite({ "/": page("Home") });
  try {
    const { core, ledger, dir } = makeGateway({ site, native: { fallback: "paid__scrape" } });
    await core.native.call("coldsearch_fetch", { url: site.url("/") }, ctx);

    const [entry] = ledger();
    assert.deepEqual(Object.keys(entry).sort(), ["args", "attempt", "client", "duration_ms", "key", "ok", "pages", "payload", "result_bytes", "session", "tool", "ts", "upstream"]);
    const payloadFile = path.join(dir, "gateway-payloads", entry.payload);
    const payload = JSON.parse(readFileSync(payloadFile, "utf8"));
    assert.deepEqual(payload.request, { name: "coldsearch_fetch", arguments: { url: site.url("/") } });
    assert.match(payload.response.content[1].text, /^# Home/);
    assert.equal(statSync(payloadFile).mode & 0o777, 0o600);

    const status = core.status();
    assert.deepEqual(status.native, { tools: ["coldsearch_fetch", "coldsearch_map", "coldsearch_crawl"], fallback: "paid__scrape", delay_ms: 500, max_paid_pages: 10 });
    assert.deepEqual(
      status.last_24h.map((row) => [row.upstream, row.key, row.calls, row.errors]),
      [["coldsearch", "coldsearch:keyless", 1, 0]]
    );
  } finally {
    await site.close();
  }
});

test("agents see the native tools beside coldsearch_status in both modes, with descriptions that say when to use them and what they cannot do", async () => {
  const site = await startSite({ "/": page("Home") });
  try {
    for (const mode of ["all", "lazy"]) {
      const { core } = makeGateway({ site, mode });
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await createGatewayServer(core, []).connect(serverSide);
      const client = new Client({ name: "agent-under-test", version: "1.0.0" });
      await client.connect(clientSide);

      const { tools } = await client.listTools();
      const native = tools.filter((tool) => ["coldsearch_fetch", "coldsearch_map", "coldsearch_crawl"].includes(tool.name));
      assert.equal(native.length, 3, mode);
      assert.ok(tools.some((tool) => tool.name === "coldsearch_status"));
      for (const tool of native) {
        assert.match(tool.description, /before any provider/, `${tool.name} says when to prefer it`);
        assert.match(tool.description, /JavaScript/, `${tool.name} says it does not run JavaScript`);
      }
      for (const name of ["coldsearch_fetch", "coldsearch_crawl"]) {
        assert.match(native.find((tool) => tool.name === name).description, /bot protection/);
      }
      assert.match(client.getInstructions(), /coldsearch_fetch, coldsearch_map, coldsearch_crawl first/);

      const fetched = await client.callTool({ name: "coldsearch_fetch", arguments: { url: site.url("/") } });
      assert.match(fetched.content[1].text, /^# Home/);
      if (mode === "lazy") {
        const viaCall = await client.callTool({ name: "coldsearch_call_tool", arguments: { name: "coldsearch_fetch", arguments: { url: site.url("/") } } });
        assert.match(viaCall.content[1].text, /^# Home/);
      }
      await client.close();
    }

    const off = makeGateway({ native: { enabled: false } });
    assert.equal(off.core.native, undefined);
    assert.equal(off.core.status().native, undefined);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createGatewayServer(off.core, []).connect(serverSide);
    const client = new Client({ name: "agent-under-test", version: "1.0.0" });
    await client.connect(clientSide);
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), ["coldsearch_status", "paid__scrape"]);
    await client.close();
  } finally {
    await site.close();
  }
});

test("[gateway.native] config errors name the field", () => {
  const config = (native, upstreams = { paid: { url: "https://paid.example.com/mcp", keys: ["env:PAID_KEY"] } }) =>
    resolveGatewayConfig({ upstreams, native });

  assert.deepEqual(config(undefined).native, { enabled: true, fallback: undefined, fallbackArguments: { url: "{url}" }, delayMs: 500, maxPaidPages: 10 });
  assert.throws(() => config({ fallback: "scrape" }), /native\.fallback must be a gateway tool name, <upstream>__<tool>/);
  assert.throws(() => config({ fallback: "firecrawl__scrape" }), /native\.fallback names upstream "firecrawl", which has no \[gateway\.upstreams\.firecrawl\] block/);
  assert.throws(() => config({ fallback: "paid__scrape", fallback_arguments: { url: "fixed" } }), /native\.fallback_arguments must contain the string "\{url\}"/);
  assert.throws(() => config({ fallback_arguments: { url: "{url}" } }), /native\.fallback_arguments is set but native\.fallback is not/);
  assert.throws(() => config({ delay_ms: -1 }), /native\.delay_ms must be a whole number/);
  assert.throws(() => config({ max_paid_pages: 1.5 }), /native\.max_paid_pages must be a whole number/);
  assert.throws(() => config({ enabled: "yes" }), /native\.enabled must be true or false/);
  assert.throws(() => config(undefined, { coldsearch: { url: "https://example.com/mcp", keys: ["env:K"] } }), /upstream name "coldsearch" is taken/);
});
