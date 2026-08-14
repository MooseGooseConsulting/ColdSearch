import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  ALLOWED_STATUSES,
  REQUIRED_PROVIDER_PATHS,
} from "./provider-pass-through.mjs";

const root = process.cwd();
const failures = [];

async function exists(relativePath) {
  try {
    await stat(path.join(root, relativePath));
    return true;
  } catch {
    return false;
  }
}

async function read(relativePath) {
  try {
    return await readFile(path.join(root, relativePath), "utf8");
  } catch (error) {
    fail(`Unable to read ${relativePath}: ${error.message}`);
    return "";
  }
}

function fail(message) {
  failures.push(message);
}

async function requireFile(relativePath) {
  if (!(await exists(relativePath))) {
    fail(`Missing required file: ${relativePath}`);
  }
}

async function readJsonl(relativePath) {
  const text = await read(relativePath);
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        fail(`${relativePath}:${index + 1} is not valid JSON: ${error.message}`);
        return null;
      }
    })
    .filter(Boolean);
}

async function walk(dir, files = []) {
  for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
    const relativePath = path.join(dir, entry.name).replaceAll("\\", "/");
    if (entry.isDirectory()) {
      await walk(relativePath, files);
    } else {
      files.push(relativePath);
    }
  }
  return files;
}

/**
 * Enough YAML trigger parsing to enforce the canary's narrow contract without
 * turning documentation validation into a general workflow/static-analysis
 * engine. Handles inline, mapping, and sequence forms of `on`.
 */
function workflowHasPushOrPrTrigger(text) {
  const lines = text.split(/\r?\n/);
  const forbiddenEvents = new Set(["push", "pull_request", "pull_request_target"]);

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(\s*)(?:on|"on"|'on')\s*:\s*(.*?)\s*$/);
    if (!match) continue;

    const baseIndent = match[1].length;
    const inline = match[2].replace(/\s+#.*$/, "").trim();
    if (inline) {
      for (const event of forbiddenEvents) {
        if (new RegExp(`\\b${event}\\b`).test(inline)) return true;
      }
      return false;
    }

    for (let j = i + 1; j < lines.length; j++) {
      const raw = lines[j];
      if (/^\s*(?:#.*)?$/.test(raw)) continue;

      const indent = (raw.match(/^(\s*)/) || ["", ""])[1].length;
      if (indent <= baseIndent) break;

      const trimmed = raw.trim();
      const mappingEvent = trimmed.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:/)?.[1];
      const sequenceEvent = trimmed.match(/^-\s*([A-Za-z_][A-Za-z0-9_-]*)(?:\s*:.*)?$/)?.[1];
      const event = mappingEvent || sequenceEvent;
      if (event && forbiddenEvents.has(event)) return true;
    }

    return false;
  }

  return false;
}

const planFiles = [
  "plans/2026-06-22-pr1-provider-tool-surface.md",
  "plans/2026-06-22-pr2-cache-a2.md",
  "plans/2026-06-22-pr3-batch-runner.md",
  "plans/2026-06-22-pr4-config-status-ux.md",
  "plans/2026-06-22-pr5-agent-run-ids.md",
];

for (const file of [
  "plans/2026-06-22-remaining-implementation-master-plan.md",
  "plans/2026-06-23-gate-0-provider-pass-through-proof.md",
  "plans/2026-08-10-live-provider-conformance.md",
  ...planFiles,
  "plans/2026-06-22-epic-5-remote-agentic-execution.md",
  "docs/NORTH_STAR.md",
  "docs/architecture.md",
  "docs/PROVIDERS.md",
]) {
  await requireFile(file);
}

const master = await read("plans/2026-06-22-remaining-implementation-master-plan.md");
const gate0 = await read("plans/2026-06-23-gate-0-provider-pass-through-proof.md");
const pr1 = await read("plans/2026-06-22-pr1-provider-tool-surface.md");
for (const file of planFiles) {
  const basename = path.basename(file);
  if (!master.includes(basename)) {
    fail(`Master plan does not link ${basename}`);
  }
}

if (!master.includes("2026-06-23-gate-0-provider-pass-through-proof.md")) {
  fail("Master plan does not link the Gate 0 provider pass-through proof plan.");
}

if (!master.includes("2026-08-10-live-provider-conformance.md")) {
  fail("Master plan does not link ongoing live provider conformance.");
}

if (!gate0.includes("provider-native") || !gate0.includes("ColdSearch")) {
  fail("Gate 0 plan must require provider-native vs ColdSearch comparison.");
}

if (!gate0.includes("Agent mode") || !gate0.includes("does not cover")) {
  fail("Gate 0 plan must explicitly exclude agentic testing.");
}

if (!pr1.includes("Pass-Through Parity Requirement")) {
  fail("PR 1 plan must include the pass-through parity requirement.");
}

if (!pr1.includes("provider-native") || !pr1.includes("coldsearch tool call")) {
  fail("PR 1 plan must require provider-native vs coldsearch tool call evidence.");
}

if (!master.includes("Non-Negotiable PR Review Pause")) {
  fail("Master plan is missing the non-negotiable review pause.");
}

if (/four PRs fit/i.test(master)) {
  fail("Master plan still claims four PRs fit.");
}

if (/Vendor-specific tool and vertical expansion/i.test(master)) {
  fail("Master plan still defers provider-tool expansion generically.");
}

for (const file of planFiles) {
  const text = await read(file);
  for (const section of ["## Scope", "## Tasks", "## Required Tests", "## Validation", "## Success Criteria", "## PR Review Pause"]) {
    if (!text.includes(section)) {
      fail(`${file} is missing ${section}`);
    }
  }
  const validationSection = (text.match(/## Validation\b([\s\S]*?)(?=\n#{1,2} |$)/) || [])[1] || "";
  if (!/\bWhat these prove:/.test(validationSection) || !/\bExpected:/.test(validationSection)) {
    fail(`${file} must explain what its validation proves: include a "What these prove:" and an "Expected:" block inside its ## Validation section.`);
  }
  if (!/Do not start PR \d+ until PR \d+ is merged unless the user explicitly authorizes parallel work/.test(text) && !/Merge PR 5 only after/.test(text)) {
    fail(`${file} does not enforce the review pause before the next PR.`);
  }
}

const pr2 = await read("plans/2026-06-22-pr2-cache-a2.md");
for (const command of [
  "coldsearch history recent",
  "coldsearch history search <query>",
  "coldsearch history show <execution-id>",
  "coldsearch history show <execution-id> --by-provider",
  "coldsearch history clear --all",
  "coldsearch cache stats",
  "coldsearch cache clear",
  "--freshness <duration>",
]) {
  if (!pr2.includes(command)) {
    fail(`PR 2 plan is missing required operator surface: ${command}`);
  }
}

const docsAndPlans = [
  ...(await walk("docs")),
  ...(await walk("plans")),
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
].filter((file) => file.endsWith(".md"));

for (const file of docsAndPlans) {
  const text = await read(file);
  if (text.includes("docs/PROGRESS.md") || text.includes("PROGRESS.md")) {
    fail(`${file} still references deleted PROGRESS.md.`);
  }
  if (/PR1[–-]PR4/.test(text)) {
    fail(`${file} still references PR1-PR4 as the active sequence.`);
  }
}

const architecture = await read("docs/architecture.md");
if (!architecture.includes("| Remote / hybrid worker implementation | Deferred |")) {
  fail("architecture.md must mark remote/hybrid worker implementation as Deferred.");
}

// Enforce the concrete normal-test boundary. Do not attempt to statically follow
// arbitrary shell/npm indirection from every workflow; that would turn this
// documentation validator into a brittle workflow execution analyzer.
const packageJson = JSON.parse(await read("package.json"));
for (const scriptName of ["test", "test:docs"]) {
  const command = packageJson.scripts?.[scriptName] ?? "";
  if (/provider-pass-through|smoke\.mjs/.test(command)) {
    fail(`${scriptName} must not run live provider conformance or smoke checks.`);
  }
}

// The dedicated live canary itself must remain schedule/manual only.
const canaryWorkflow = await read(".github/workflows/canary.yml");
if (workflowHasPushOrPrTrigger(canaryWorkflow)) {
  fail("Live provider canary must not run on push, pull_request, or pull_request_target.");
}

const rootEntries = await readdir(root);
const allowedRootJson = new Set([
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "renovate.json",
]);
const rootResearchJson = rootEntries.filter(
  (name) => name.endsWith(".json") && !allowedRootJson.has(name)
);
if (rootResearchJson.length > 0) {
  fail(`Research JSON artifacts should not live at repo root: ${rootResearchJson.join(", ")}`);
}

const queryTokenPatterns = [
  /([?&]|\b)jwt=(?!REDACTED(?:[&#"'\s]|$))[^&#"'\s]+/i,
  /([?&]|\b)redir_token=(?!REDACTED(?:[&#"'\s]|$))[^&#"'\s]+/i,
  /([?&]|\b)access_token=(?!REDACTED(?:[&#"'\s]|$))[^&#"'\s]+/i,
  /([?&]|\b)api_key=(?!REDACTED(?:[&#"'\s]|$))[^&#"'\s]+/i,
];

const providerEvidenceTokenPatterns = [
  ...queryTokenPatterns,
  /\bBearer\s+(?!REDACTED\b)[A-Za-z0-9._~+/=-]+/i,
  /\bX-API-KEY["':\s]+(?!REDACTED\b)[A-Za-z0-9._~+/=-]+/i,
  /\bX-Subscription-Token["':\s]+(?!REDACTED\b)[A-Za-z0-9._~+/=-]+/i,
];

const providerEvidenceDir = "plans/evidence/2026-06-23-provider-pass-through";
await requireFile(`${providerEvidenceDir}/summary.md`);
await requireFile(`${providerEvidenceDir}/results.jsonl`);

if (await exists(providerEvidenceDir)) {
  const rows = await readJsonl(`${providerEvidenceDir}/results.jsonl`);
  const expected = REQUIRED_PROVIDER_PATHS.map((row) => `${row.provider}:${row.path}`);
  const seen = new Set();

  for (const row of rows) {
    const key = `${row.provider}:${row.path}`;
    if (seen.has(key)) {
      fail(`${providerEvidenceDir}/results.jsonl has duplicate row for ${key}`);
    }
    seen.add(key);

    if (!ALLOWED_STATUSES.includes(row.status)) {
      fail(`${providerEvidenceDir}/results.jsonl has unsupported status for ${key}: ${row.status}`);
    }
  }

  for (const key of expected) {
    if (!seen.has(key)) {
      fail(`${providerEvidenceDir}/results.jsonl is missing required row ${key}`);
    }
  }

  const summary = await read(`${providerEvidenceDir}/summary.md`);
  // The committed baseline is a historical full-matrix snapshot and cannot be
  // regenerated in CI (that would require paid live calls), so it is validated
  // against the status vocabulary in effect when it was generated: statuses
  // added after the baseline (e.g. not_run) legitimately do not appear in it.
  // Every pre-existing status must still be enumerated even at zero count, so
  // a baseline that accidentally drops a status cannot hide.
  const postBaselineStatuses = new Set(["not_run"]);
  for (const status of ALLOWED_STATUSES) {
    if (postBaselineStatuses.has(status)) continue;
    if (!summary.includes(status)) {
      fail(`${providerEvidenceDir}/summary.md does not enumerate status ${status}`);
    }
  }

  const evidenceFiles = await walk(providerEvidenceDir);
  for (const file of evidenceFiles) {
    const text = await read(file);
    if (providerEvidenceTokenPatterns.some((pattern) => pattern.test(text))) {
      fail(`${file} appears to contain an unredacted signed URL, bearer token, or API key.`);
    }
  }
}

const evidenceDir = "plans/evidence/2026-06-22-remote-agentic-execution";
if (await exists(evidenceDir)) {
  const evidenceFiles = (await walk(evidenceDir)).filter((file) => file.endsWith(".json"));
  if (evidenceFiles.length === 0) {
    fail(`${evidenceDir} exists but contains no JSON evidence files.`);
  }
  for (const file of evidenceFiles) {
    const text = await read(file);
    if (queryTokenPatterns.some((pattern) => pattern.test(text))) {
      fail(`${file} appears to contain an unredacted signed URL or API token query parameter.`);
    }
  }
} else {
  fail(`Missing evidence directory: ${evidenceDir}`);
}

if (failures.length > 0) {
  console.error("Documentation validation failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log("Documentation validation passed.");
}
