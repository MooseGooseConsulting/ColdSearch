# P1 — CLI-to-container execution design (draft for GitHub issue)

**Status:** draft — file as part of issue #79 follow-up set.

## Problem

Execution today is local-process only (`LocalExecutionBackend`). The batch
runner and agent mode assume the CLI's filesystem for state, history, cache,
and capture output. There is no design for running the same commands inside a
container with different state mounts, ephemeral filesystems, or
network-restricted egress.

## Design questions to answer

1. State layout: are cache/history/config paths overridable today (env vars)?
   Audit and document; fill gaps.
2. Capture harness (PR-E) writes to `COLDSEARCH_CAPTURE_DIR` — define the
   container contract (volume mount, read-only rootfs compatibility).
3. Egress policy: provider hosts needed per capability (see live-probe
   ledger: jina/brave/brightdata blocked from restricted networks) — ship an
   allowlist doc for firewall configuration.
4. Secrets: use Doppler-managed injection or the runtime-supported `doppler:`
   and `env:` references. Mounted secret files are not supported key
   references today; include file-mount examples only if file-reference
   support is deliberately added.
5. Non-root user, graceful SIGTERM handling for in-flight async jobs
   (Firecrawl crawl poll loop should cancel upstream on shutdown — related:
   the deferred `DELETE /crawl/{id}` work).

## Done when

- [ ] `docs/container-execution.md` answers 1–5 with working examples.
- [ ] Example Dockerfile + compose snippet run the test suite green.
