import { createHash } from "node:crypto";

/**
 * The gateway dashboard: one HTML page with its CSS and script inline, served
 * at `/dashboard`. No external assets, no build step, no framework.
 *
 * Contract:
 * - The page is a shell. It holds no data, no token and no key reference;
 *   everything shown is fetched from `/api/*` after the operator types the
 *   bearer token, which is kept in `sessionStorage` (gone when the tab closes)
 *   and sent as `Authorization` on those fetches only. A gateway started
 *   without a token serves no `/api/` data, and the page says so instead of
 *   asking for a token.
 * - Every value from the API is written with `textContent`, never parsed as
 *   HTML: tool names, client names and error text come from agents and
 *   providers and are not trusted.
 * - The script and stylesheet below must not contain a backtick, a dollar
 *   sign followed by a brace, or a backslash, because they live in template
 *   literals. `test/dashboard.test.mjs` compiles the script to catch a slip.
 */

const STYLE = `
:root {
  color-scheme: light;
  --page: #f9f9f7;
  --surface: #fcfcfb;
  --ink: #0b0b0b;
  --ink-2: #52514e;
  --muted: #6f6d68;
  --line: #e1e0d9;
  --line-strong: #c3c2b7;
  --accent: #2a78d6;
  --good: #0ca30c;
  --warning: #fab219;
  --critical: #d03b3b;
  --wash: rgba(11, 11, 11, 0.04);
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --page: #0d0d0d;
    --surface: #1a1a19;
    --ink: #f0efec;
    --ink-2: #c3c2b7;
    --muted: #9a988f;
    --line: #2c2c2a;
    --line-strong: #383835;
    --accent: #3987e5;
    --critical: #e66767;
    --wash: rgba(255, 255, 255, 0.05);
  }
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html { background: var(--page); }
body {
  margin: 0;
  padding: 16px 20px 40px;
  color: var(--ink);
  font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
}
main, #gate { max-width: 1280px; margin: 0 auto; }
h1 { font-size: 16px; margin: 0; }
h2 { font-size: 13px; margin: 0; }
h3 { font-size: 13px; margin: 0; }
code { font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.top { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 14px; margin-bottom: 14px; }
.top .grow { flex: 1; }
.muted { color: var(--muted); }
.note { color: var(--ink-2); margin: 6px 0 0; }
section { margin-top: 18px; }
.section-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; margin-bottom: 6px; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; padding: 10px 12px; margin-bottom: 8px; }
.card-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 14px; margin-bottom: 6px; }
.card-head .grow { flex: 1; }
.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 4px 10px 4px 0; border-top: 1px solid var(--line); vertical-align: middle; white-space: nowrap; }
thead th { border-top: 0; color: var(--muted); font-weight: 500; font-size: 11px; }
thead tr.groups th { padding-bottom: 0; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
td.wrap { white-space: normal; min-width: 180px; }
tr.group-row td { font-weight: 600; }
tr.key-row td:first-child { padding-left: 16px; }
td.divide, th.divide { border-left: 1px solid var(--line); padding-left: 10px; }
table.pool { table-layout: fixed; min-width: 860px; }
table.pool td { white-space: normal; overflow-wrap: anywhere; }
col.c-keys { width: 26%; }
col.c-bar { width: 20%; }
col.c-figure { width: 15%; }
col.c-period { width: 13%; }
.track { height: 8px; border-radius: 4px; background: color-mix(in srgb, var(--accent) 18%, var(--surface)); overflow: hidden; }
.track .fill { height: 100%; min-width: 2px; border-radius: 4px; background: var(--accent); }
.track.spent { background: color-mix(in srgb, var(--critical) 20%, var(--surface)); }
.track.spent .fill { background: var(--critical); }
.badge { display: inline-block; margin-left: 8px; padding: 0 6px; border: 1px solid var(--line-strong); border-radius: 9px; font-size: 11px; color: var(--ink-2); }
.badge.slot { border-color: var(--accent); color: var(--ink); }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; background: var(--line-strong); }
.dot.active, .dot.ok { background: var(--good); }
.dot.skipped, .dot.error { background: var(--critical); }
.dot.standby { background: transparent; border: 1.5px solid var(--muted); }
button, input, select { font: inherit; color: inherit; }
button, select { background: var(--surface); border: 1px solid var(--line-strong); border-radius: 5px; padding: 3px 10px; cursor: pointer; }
button:hover:not(:disabled) { background: var(--wash); }
button:disabled { opacity: 0.55; cursor: default; }
button.primary { background: var(--accent); border-color: var(--accent); color: #ffffff; }
button.primary:hover:not(:disabled) { background: var(--accent); filter: brightness(1.08); }
button.link { border: 0; background: none; padding: 0; text-align: left; font-variant-numeric: tabular-nums; }
button.link:hover:not(:disabled) { background: none; text-decoration: underline; }
input[type="search"], input[type="password"] { background: var(--surface); border: 1px solid var(--line-strong); border-radius: 5px; padding: 4px 8px; }
input[type="search"] { width: min(420px, 100%); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.rotate { border-top: 1px solid var(--line); margin-top: 8px; padding-top: 8px; }
.rotate .row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.rotate dl { margin: 8px 0; display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; }
.rotate dt, .detail dt { color: var(--muted); }
.rotate dd, .detail dd { margin: 0; overflow-wrap: anywhere; }
.alert { border: 1px solid var(--critical); border-radius: 6px; padding: 6px 10px; margin-bottom: 10px; background: color-mix(in srgb, var(--critical) 10%, var(--surface)); }
tr.detail td { white-space: normal; background: var(--wash); padding: 6px 10px; }
.detail dl { margin: 0; display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; }
.detail dd code { white-space: pre-wrap; }
.stale { opacity: 0.6; }
#gate { margin-top: 12vh; max-width: 420px; }
#gate form { display: flex; gap: 8px; margin-top: 10px; }
#gate input { flex: 1; }
`;

const SCRIPT = `
(function () {
  "use strict";
  var TOKEN_KEY = "coldsearch.gateway.token";
  var REFRESH_MS = 30000;
  var memoryToken = "";
  var state = {
    status: null, ledger: null, keys: null, keysNote: "", keysLoading: false,
    rotateEnabled: false, rotate: {}, openCalls: {}, filter: ""
  };

  function byId(id) { return document.getElementById(id); }

  // Build an element. Children are elements or plain text; text is never parsed as HTML.
  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key];
        if (key === "on") {
          Object.keys(value).forEach(function (name) { node.addEventListener(name, value[name]); });
        } else if (key === "width") {
          node.style.width = value;
        } else if (value === true) {
          node.setAttribute(key, "");
        } else if (value !== false && value !== null && value !== undefined) {
          node.setAttribute(key, String(value));
        }
      });
    }
    for (var i = 2; i < arguments.length; i++) append(node, arguments[i]);
    return node;
  }
  function append(node, child) {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) { child.forEach(function (item) { append(node, item); }); return; }
    node.appendChild(typeof child === "object" ? child : document.createTextNode(String(child)));
  }
  function replace(node, children) { node.textContent = ""; append(node, children); }

  // --- formatting ----------------------------------------------------------

  function fmt(n) { return Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 }); }
  function pad(n) { return n < 10 ? "0" + n : String(n); }
  function cost(usd, credits) {
    var parts = [];
    if (usd) parts.push("$" + (usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)));
    if (credits) parts.push(fmt(credits) + " cr");
    return parts.length ? parts.join(" + ") : "–";
  }
  function clock(iso) {
    var date = new Date(iso);
    if (isNaN(date.getTime())) return String(iso);
    var time = pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
    var now = new Date();
    var sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
    return sameDay ? time : date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + " " + time;
  }
  function duration(ms) {
    if (ms < 1000) return Math.round(ms) + " ms";
    if (ms < 60000) return (ms / 1000).toFixed(2) + " s";
    return Math.floor(ms / 60000) + " m " + pad(Math.round((ms % 60000) / 1000)) + " s";
  }
  function fromNow(iso) {
    var ms = new Date(iso).getTime() - Date.now();
    if (isNaN(ms)) return "";
    var past = ms < 0;
    var minutes = Math.round(Math.abs(ms) / 60000);
    var text = minutes < 90 ? minutes + " min" : minutes < 2880 ? Math.round(minutes / 60) + " h" : Math.round(minutes / 1440) + " d";
    return past ? text + " ago" : "in " + text;
  }

  // --- token and fetch -----------------------------------------------------

  function getToken() {
    try { return sessionStorage.getItem(TOKEN_KEY) || ""; } catch (error) { return memoryToken; }
  }
  function setToken(value) {
    memoryToken = value;
    try {
      if (value) sessionStorage.setItem(TOKEN_KEY, value); else sessionStorage.removeItem(TOKEN_KEY);
    } catch (error) { /* storage unavailable: the token lives until the page is closed */ }
  }
  function AuthRequired() {}

  function api(path, options) {
    var init = options || {};
    var headers = init.headers || {};
    var token = getToken();
    if (token) headers["Authorization"] = "Bearer " + token;
    return fetch(path, { method: init.method || "GET", headers: headers, body: init.body, cache: "no-store" }).then(function (res) {
      if (res.status === 401) {
        setToken("");
        showGate(token ? "The gateway did not accept that token." : "");
        throw new AuthRequired();
      }
      if (res.status === 403 && res.headers.get("X-Coldsearch-Api") === "token-required") {
        // The gateway was started without a token: no token typed here can open it, so do not ask for one.
        return readJson(res).then(function (body) {
          showGate(body.error || "This gateway's /api/ endpoints are off.", true);
          throw new AuthRequired();
        });
      }
      return res;
    });
  }
  function readJson(res) { return res.json().catch(function () { return {}; }); }
  function needOk(res) {
    return readJson(res).then(function (body) {
      if (!res.ok) throw new Error(body.error || "HTTP " + res.status);
      return body;
    });
  }

  function showGate(message, off) {
    byId("app").hidden = true;
    byId("gate").hidden = false;
    byId("gate-ask").hidden = Boolean(off);
    byId("gate-note").textContent = message || "";
    if (!off) byId("token-input").focus();
  }
  function showApp() { byId("gate").hidden = true; byId("app").hidden = false; }
  function alertText(message) {
    var box = byId("alert");
    box.hidden = !message;
    box.textContent = message || "";
  }

  // --- loading -------------------------------------------------------------

  function loadActivity() {
    return Promise.all([
      api("/api/status").then(needOk),
      api("/api/ledger?since=24h&limit=200").then(needOk)
    ]).then(function (results) {
      state.status = results[0];
      state.ledger = results[1];
      showApp();
      alertText(state.status.ledger_error
        ? "The totals under Upstreams are missing, not zero: " + state.status.ledger_error + "."
        : "");
      renderTop();
      renderUpstreams();
      renderCalls();
    }).catch(function (error) {
      if (error instanceof AuthRequired) throw error;
      showApp();
      alertText("Gateway activity could not be loaded (" + error.message + "). Anything below is from the last successful load.");
    });
  }

  function loadKeys() {
    state.keysLoading = true;
    renderPools();
    return api("/api/keys").then(function (res) {
      return readJson(res).then(function (body) {
        if (res.ok) {
          state.keys = body;
          state.keysNote = "";
          state.rotateEnabled = res.headers.get("X-Coldsearch-Rotate") === "enabled";
        } else {
          state.keys = null;
          state.keysNote = body.error || "HTTP " + res.status;
        }
      });
    }).catch(function (error) {
      if (!(error instanceof AuthRequired)) state.keysNote = "Key pools could not be loaded (" + error.message + ").";
    }).then(function () {
      state.keysLoading = false;
      renderPools();
    });
  }

  function start() {
    loadActivity().then(loadKeys).catch(function () { /* the token form is showing */ });
  }

  // --- header --------------------------------------------------------------

  function renderTop() {
    var status = state.status;
    replace(byId("meta"), [
      "mode " + status.mode + " · " + status.upstreams.length + " upstream" + (status.upstreams.length === 1 ? "" : "s") + " · ledger ",
      el("code", null, status.ledger)
    ]);
    byId("updated").textContent = "updated " + clock(new Date().toISOString());
  }

  // --- key pools -----------------------------------------------------------

  function renderPools() {
    var body = byId("pools-body");
    body.className = state.keysLoading && state.keys ? "stale" : "";
    byId("pools-note").textContent = state.keys && !state.rotateEnabled
      ? "Rotation from this page is off: the gateway was started without --allow-rotate."
      : "";
    if (!state.keys) {
      replace(body, el("p", { class: "note" }, state.keysLoading ? "Reading key pools…" : state.keysNote));
      return;
    }
    replace(body, state.keys.providers.map(renderProvider));
  }

  function renderProvider(provider) {
    var target = provider.points_at
      ? el("code", null, provider.points_at)
      : el("span", null, provider.slot_note || "nothing readable");
    var head = el("div", { class: "card-head" },
      el("h3", null, provider.provider),
      el("span", { title: "Doppler " + provider.project + "/" + provider.config }, el("code", null, provider.slot), " points at ", target),
      el("span", { class: "muted" }, "policy " + provider.policy + " · floor " + fmt(provider.floor)),
      el("span", { class: "grow" }),
      state.rotateEnabled
        ? el("button", { type: "button", on: { click: function () { toggleRotate(provider); } } }, "Rotate…")
        : null
    );
    var notes = [];
    if (provider.ledger_note) notes.push(el("p", { class: "note" }, "Ledger not read: " + provider.ledger_note));
    if (provider.slot_ledger_calls) {
      notes.push(el("p", { class: "note" },
        "Ledger: " + spend(provider.slot_ledger_usd || 0, provider.slot_ledger_calls) + " made with " + provider.slot + " itself"));
    }
    var table = el("table", { class: "pool" },
      el("colgroup", null,
        el("col", { class: "c-keys" }), el("col", { class: "c-bar" }), el("col", { class: "c-figure" }), el("col", { class: "c-period" }), el("col")),
      el("thead", null, el("tr", null,
        el("th", null, "Account keys"),
        el("th", null, "Allowance left"),
        el("th", { class: "num" }, "Remaining / limit"),
        el("th", null, "Period ends"),
        el("th", null, "Note"))),
      el("tbody", null, provider.accounts.map(accountRow)));
    return el("div", { class: "card" }, head, notes, el("div", { class: "scroll" }, table), rotatePanel(provider));
  }

  function spend(usd, calls) { return "$" + usd.toFixed(2) + " over " + fmt(calls) + " call" + (calls === 1 ? "" : "s"); }

  function accountRow(account) {
    var known = account.remaining !== null;
    var figure = known
      ? fmt(account.remaining) + (account.limit !== null ? " / " + fmt(account.limit) : "") + (account.unit ? " " + account.unit : "")
      : "?";
    var bar = null;
    if (known && account.limit) {
      var ratio = Math.max(0, Math.min(1, account.remaining / account.limit));
      bar = el("div", { class: "track" + (account.spent ? " spent" : ""), role: "img", title: figure, "aria-label": figure + " remaining" },
        account.remaining > 0 ? el("div", { class: "fill", width: (ratio * 100).toFixed(1) + "%" }) : null);
    } else if (known) {
      bar = el("span", { class: "muted" }, "no limit reported");
    }
    var notes = [];
    if (account.unknown) notes.push(account.unknown);
    if (account.spent) notes.push("at or below the floor");
    if (account.keys.length > 1) notes.push("one account");
    if (account.ledger_calls !== null && account.ledger_usd !== null) notes.push("ledger: " + spend(account.ledger_usd, account.ledger_calls));
    var period = account.period_end
      ? [String(account.period_end).slice(0, 10), el("span", { class: "muted" }, " " + fromNow(account.period_end))]
      : "–";
    var names = [];
    account.keys.forEach(function (name, index) {
      if (index) names.push(", ");
      names.push(el("code", null, name));
    });
    return el("tr", null,
      el("td", null, names, account.in_slot ? el("span", { class: "badge slot" }, "in slot") : null),
      el("td", null, bar),
      el("td", { class: "num" }, figure),
      el("td", null, period),
      el("td", null, notes.join("; ")));
  }

  // --- rotation ------------------------------------------------------------

  function rotation(provider) {
    if (!state.rotate[provider.provider]) {
      state.rotate[provider.provider] = { open: false, to: "", busy: false, preview: null, done: null, error: "" };
    }
    return state.rotate[provider.provider];
  }
  function toggleRotate(provider) {
    var r = rotation(provider);
    state.rotate[provider.provider] = { open: !r.open, to: "", busy: false, preview: null, done: null, error: "" };
    renderPools();
  }

  function requestRotation(provider, dryRun, to) {
    var r = rotation(provider);
    var payload = { provider: provider.provider, dry_run: dryRun };
    if (to) payload.to = to;
    r.busy = true;
    r.error = "";
    renderPools();
    return api("/api/keys/rotate", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Coldsearch-Confirm": "rotate" },
      body: JSON.stringify(payload)
    }).then(function (res) {
      return readJson(res).then(function (body) {
        if (body.outcome) {
          if (dryRun) { r.preview = body; } else { r.done = body; r.preview = null; }
        } else {
          r.error = body.error || "HTTP " + res.status;
        }
        return body;
      });
    }).catch(function (error) {
      if (!(error instanceof AuthRequired)) r.error = error.message;
      return {};
    }).then(function (body) {
      r.busy = false;
      renderPools();
      if (!dryRun && body.outcome === "rotated") loadKeys();
    });
  }

  function outcomeLines(provider, answer) {
    var lines = [el("dt", null, "Slot"), el("dd", null, el("code", null, answer.slot)),
      el("dt", null, "Was"), el("dd", null, answer.before)];
    var label = { "dry-run": "Would be", rotated: "Now", unchanged: "Stays", refused: "Nothing changed" }[answer.outcome] || answer.outcome;
    lines.push(el("dt", null, label), el("dd", null, answer.after || "–"));
    lines.push(el("dt", null, "Why"), el("dd", null, answer.reason));
    return el("dl", null, lines);
  }

  function rotatePanel(provider) {
    var r = rotation(provider);
    if (!r.open) return null;
    var names = [];
    provider.accounts.forEach(function (account) { account.keys.forEach(function (name) { names.push(name); }); });
    var select = el("select", {
      "aria-label": "Rotation target", disabled: r.busy,
      on: { change: function (event) { r.to = event.target.value; r.preview = null; r.done = null; r.error = ""; renderPools(); } }
    },
      el("option", { value: "" }, "Let the policy choose (" + provider.policy + ")"),
      names.map(function (name) { return el("option", { value: name }, name); }));
    select.value = r.to;

    var children = [el("div", { class: "row" },
      el("strong", null, "Rotate " + provider.slot),
      select,
      el("button", { type: "button", disabled: r.busy, on: { click: function () { requestRotation(provider, true, r.to); } } },
        r.busy && !r.preview ? "Checking…" : "Preview"),
      el("button", { type: "button", disabled: r.busy, on: { click: function () { toggleRotate(provider); } } }, "Close"),
      el("span", { class: "muted" }, "Preview is a dry run: it writes nothing."))];

    if (r.error) children.push(el("p", { class: "note" }, "Not done: " + r.error));
    if (r.preview) {
      children.push(outcomeLines(provider, r.preview));
      if (r.preview.outcome === "dry-run") {
        var target = r.preview.after;
        children.push(el("div", { class: "row" },
          el("button", { type: "button", class: "primary", disabled: r.busy, on: { click: function () { requestRotation(provider, false, target); } } },
            r.busy ? "Rotating…" : "Point " + provider.slot + " at " + target),
          el("span", { class: "muted" }, "This rewrites the slot in Doppler. Everything that reads it moves to the new account.")));
      }
    }
    if (r.done) children.push(outcomeLines(provider, r.done));
    return el("div", { class: "rotate" }, children);
  }

  // --- upstreams -----------------------------------------------------------

  function blank() { return { calls: 0, errors: 0, quota_errors: 0, usd: 0, credits: 0 }; }
  function add(total, row) {
    total.calls += row.calls; total.errors += row.errors; total.quota_errors += row.quota_errors;
    total.usd += row.usd; total.credits += row.credits;
  }
  function index(rows) {
    var out = {};
    (rows || []).forEach(function (row) {
      if (!out[row.upstream]) out[row.upstream] = { total: blank(), keys: {} };
      add(out[row.upstream].total, row);
      out[row.upstream].keys[row.key] = row;
    });
    return out;
  }
  function figures(row, first) {
    var r = row || blank();
    return [
      el("td", { class: "num" + (first ? " divide" : "") }, fmt(r.calls)),
      el("td", { class: "num" }, fmt(r.errors)),
      el("td", { class: "num" }, fmt(r.quota_errors)),
      el("td", { class: "num" }, cost(r.usd, r.credits))
    ];
  }
  function keyState(key) {
    if (key.state === "skipped") {
      return [el("span", { class: "dot skipped" }), "skipped: " + (key.reason || "fault") +
        (key.retry_at ? ", retry " + clock(key.retry_at) + " (" + fromNow(key.retry_at) + ")" : "")];
    }
    return [el("span", { class: "dot " + key.state }), key.state];
  }

  function renderUpstreams() {
    var status = state.status;
    var day = index(status.last_24h);
    var week = index(status.last_7d);
    var rows = [];
    var seen = {};
    function group(name, tools, error, keys, configured) {
      seen[name] = true;
      var d = day[name] || { total: blank(), keys: {} };
      var w = week[name] || { total: blank(), keys: {} };
      var groupState = !configured ? "not in the config now"
        : error ? [el("span", { class: "dot error" }), "error: " + error]
        : tools === null ? "tools not listed yet" : fmt(tools) + " tools";
      rows.push(el("tr", { class: "group-row" },
        el("td", null, name),
        el("td", { class: "wrap" + (configured ? "" : " muted") }, groupState),
        figures(d.total, true), figures(w.total, true)));
      var listed = {};
      keys.forEach(function (key) {
        listed[key.key] = true;
        rows.push(el("tr", { class: "key-row" },
          el("td", null, el("code", null, key.key)),
          el("td", { class: "wrap" }, keyState(key)),
          figures(d.keys[key.key], true), figures(w.keys[key.key], true)));
      });
      Object.keys(w.keys).forEach(function (ref) {
        if (listed[ref]) return;
        // An upstream that takes no key has an empty key list, and the ledger files its calls under "<name>:keyless".
        var keyless = configured && !keys.length && ref === name + ":keyless";
        rows.push(el("tr", { class: "key-row" },
          el("td", null, el("code", null, ref)),
          el("td", { class: "wrap" + (keyless ? "" : " muted") }, keyless ? "no key: this upstream takes none" : "not in the config now"),
          figures(d.keys[ref], true), figures(w.keys[ref], true)));
      });
    }
    status.upstreams.forEach(function (upstream) { group(upstream.name, upstream.tools, upstream.error, upstream.keys, true); });
    Object.keys(week).forEach(function (name) {
      if (!seen[name]) group(name, null, "", [], false);
    });
    var heads = ["Calls", "Errors", "Quota errors", "Cost"];
    var table = el("table", null,
      el("thead", null,
        el("tr", { class: "groups" },
          el("th", { colspan: 2 }), el("th", { colspan: 4, class: "divide" }, "Last 24 hours"), el("th", { colspan: 4, class: "divide" }, "Last 7 days")),
        el("tr", null,
          el("th", null, "Upstream and keys"), el("th", null, "State"),
          heads.map(function (text, i) { return el("th", { class: "num" + (i ? "" : " divide") }, text); }),
          heads.map(function (text, i) { return el("th", { class: "num" + (i ? "" : " divide") }, text); }))),
      el("tbody", null, rows));
    replace(byId("upstreams-body"), el("div", { class: "card scroll" }, table));
  }

  // --- recent calls --------------------------------------------------------

  function callId(entry) { return [entry.ts, entry.session, entry.upstream, entry.tool, entry.attempt].join("|"); }
  function resultText(entry) {
    var text = entry.ok ? "ok" : "error: " + (entry.error_class || "unknown");
    return entry.attempt > 1 ? text + " · attempt " + entry.attempt : text;
  }
  function haystack(entry) {
    return [entry.ts, clock(entry.ts), entry.client, entry.upstream, entry.tool, entry.key, resultText(entry), entry.error, entry.args, entry.session]
      .join(" ").toLowerCase();
  }
  function detail(entry) {
    var pairs = [];
    function pair(label, value, mono) {
      if (value === undefined || value === null || value === "") return;
      pairs.push(el("dt", null, label), el("dd", null, mono ? el("code", null, value) : String(value)));
    }
    pair("Started", entry.ts);
    pair("Error", entry.error);
    pair("Arguments", entry.args, true);
    pair("Session", entry.session, true);
    pair("Result size", entry.result_bytes === undefined ? "" : fmt(entry.result_bytes) + " bytes");
    pair("Payload file", entry.payload, true);
    return el("tr", { class: "detail" }, el("td", { colspan: 8 }, el("dl", null, pairs)));
  }

  function renderCalls() {
    var ledger = state.ledger;
    var words = state.filter.toLowerCase().split(" ").filter(Boolean);
    var shown = ledger.entries.filter(function (entry) {
      var text = haystack(entry);
      return words.every(function (word) { return text.indexOf(word) !== -1; });
    });
    var rows = [];
    shown.forEach(function (entry) {
      var id = callId(entry);
      var open = Boolean(state.openCalls[id]);
      rows.push(el("tr", null,
        el("td", null, el("button", {
          type: "button", class: "link", title: entry.ts, "aria-expanded": open ? "true" : "false",
          on: { click: function () { state.openCalls[id] = !open; renderCalls(); } }
        }, (open ? "▾ " : "▸ ") + clock(entry.ts))),
        el("td", null, entry.client || "–"),
        el("td", null, entry.upstream),
        el("td", null, entry.tool),
        el("td", null, el("code", null, entry.key)),
        el("td", null, el("span", { class: "dot " + (entry.ok ? "ok" : "error") }), resultText(entry)),
        el("td", { class: "num" }, duration(entry.duration_ms)),
        el("td", { class: "num" }, entry.cost ? cost(entry.cost.usd, entry.cost.credits) : "–")));
      if (open) rows.push(detail(entry));
    });
    var count = fmt(shown.length) + " of " + fmt(ledger.entries.length) + " shown";
    if (ledger.matched > ledger.entries.length) count += " · newest " + fmt(ledger.entries.length) + " of " + fmt(ledger.matched) + " in the last 24 hours";
    byId("calls-count").textContent = count;
    if (!rows.length) {
      replace(byId("calls-body"), el("p", { class: "note" },
        ledger.entries.length ? "No call matches the filter." : "No calls in the last 24 hours."));
      return;
    }
    var heads = ["Time", "Client", "Upstream", "Tool", "Key", "Result"];
    replace(byId("calls-body"), el("div", { class: "card scroll" }, el("table", null,
      el("thead", null, el("tr", null,
        heads.map(function (text) { return el("th", null, text); }),
        el("th", { class: "num" }, "Duration"), el("th", { class: "num" }, "Cost"))),
      el("tbody", null, rows))));
  }

  // --- wiring --------------------------------------------------------------

  byId("gate-form").addEventListener("submit", function (event) {
    event.preventDefault();
    var input = byId("token-input");
    setToken(input.value.trim());
    input.value = "";
    start();
  });
  byId("refresh").addEventListener("click", start);
  byId("forget").addEventListener("click", function () { setToken(""); showGate(""); });
  byId("filter").addEventListener("input", function (event) {
    state.filter = event.target.value;
    if (state.ledger) renderCalls();
  });
  // Key pools are not refreshed on a timer: each read asks Doppler and every provider's usage endpoint.
  setInterval(function () {
    if (document.visibilityState === "visible" && !byId("app").hidden) loadActivity().catch(function () {});
  }, REFRESH_MS);
  start();
})();
`;

const sha256 = (text: string): string => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

/**
 * Content-Security-Policy for the dashboard. Only the inline script and
 * stylesheet in this file may run, fetches go to the gateway's own origin
 * only, and the page may not be framed, so another site cannot overlay it to
 * steer a click onto the Rotate button.
 */
export const DASHBOARD_CSP = [
  "default-src 'none'",
  `script-src ${sha256(SCRIPT)}`,
  `style-src ${sha256(STYLE)}`,
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** The whole page. Static: the same bytes for every request and every gateway. */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ColdSearch gateway</title>
<style>${STYLE}</style>
</head>
<body>
<div id="gate" hidden>
  <h1>ColdSearch gateway</h1>
  <div id="gate-ask">
    <p class="note">Enter the gateway's bearer token. It is kept for this tab only and sent to this gateway only.</p>
    <form id="gate-form">
      <input id="token-input" type="password" autocomplete="off" aria-label="Gateway token" placeholder="Gateway token">
      <button type="submit" class="primary">Open dashboard</button>
    </form>
  </div>
  <p class="note" id="gate-note" role="status"></p>
</div>
<main id="app" hidden>
  <div class="top">
    <h1>ColdSearch gateway</h1>
    <span class="muted" id="meta"></span>
    <span class="grow"></span>
    <span class="muted" id="updated"></span>
    <button type="button" id="refresh">Refresh</button>
    <button type="button" id="forget">Forget token</button>
  </div>
  <div class="alert" id="alert" role="status" hidden></div>
  <section>
    <div class="section-head"><h2>Key pools</h2><span class="muted" id="pools-note"></span></div>
    <div id="pools-body"></div>
  </section>
  <section>
    <div class="section-head"><h2>Upstreams</h2></div>
    <div id="upstreams-body"></div>
  </section>
  <section>
    <div class="section-head">
      <h2>Recent calls</h2>
      <input id="filter" type="search" aria-label="Filter recent calls" placeholder="Filter by client, upstream, tool, key, result or error">
      <span class="muted" id="calls-count"></span>
    </div>
    <div id="calls-body"></div>
  </section>
</main>
<script>${SCRIPT}</script>
</body>
</html>
`;
