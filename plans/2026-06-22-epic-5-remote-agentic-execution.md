# Epic 5: Remote Agentic Execution

**Status:** Deferred — not in the active five-PR sequence (PR1–PR5).

**Goal (when promoted):** CLI submits long-running research and batch work to a remote execution plane; workers run agentic flows (search → read → refine → synthesize) and normalized capability calls without blocking the terminal. The `coldsearch` CLI remains the operator surface; execution may run elsewhere.

This epic is **not** PR1–PR5. Those PRs extend the in-process CLI on `main`. Epic 5 is a separate track, opened only when explicitly prioritized.

---

## What problem it solves (later)

- Agent runs that outlive a shell session (submit, disconnect, poll or stream).
- Batch enrichment at volume without a single long-lived CLI process.
- Shared cache, concurrency, and rate limits across workers (when multiple processes exist).
- Trace correlation across agent steps and provider calls at job scale.

## What stays in ColdSearch (even with remote execution)

- Normalized capabilities: `search`, `extract`, `crawl`.
- Config-driven provider pools and routing policy (human control, not model-picked providers).
- Provider adapters and shared result schemas.
- SSRF policy on agent `fetch`.
- `ExecutionBackend` seam — today `LocalExecutionBackend`; future `RemoteExecutionBackend`.

The agent runtime does **not** need to be TypeScript. Tools should call ColdSearch capabilities (or the same backend the CLI uses), not raw vendor APIs.

## What we considered (June 2026) — not decided

Research and discussion reviewed packaged options instead of rolling custom daemon + SQLite state:

| Layer | Candidates | Notes |
| --- | --- | --- |
| Durable jobs / workers | [Hatchet](https://hatchet.run/), [Inngest](https://www.inngest.com/), [Trigger.dev](https://trigger.dev/), [BullMQ](https://docs.bullmq.io/) + Redis | Workflow orchestration and worker processes — **not** a place to “host the whole app.” Tasks invoke ColdSearch code; run state lives in the engine’s store. BullMQ is queue-only (minimal). |
| Agent loop / tools | [Vercel AI SDK](https://ai-sdk.dev), [Mastra](https://mastra.ai/), [OpenAI Agents SDK JS](https://openai.github.io/openai-agents-js/), [LangGraph JS](https://langchain-ai.github.io/langgraphjs/), [Inngest AgentKit](https://agentkit.inngest.com/) | TypeScript-friendly agent harnesses; pair with a durable layer for non-blocking runs. |
| Platform agent runtime | [Cloudflare Agents](https://developers.cloudflare.com/agents/) | Durable agents on Workers — only if portability to generic self-host is abandoned. |
| Persistent agent product | [Hermes Agent](https://hermes-agent.org/) | Self-hosted agent OS (memory, scheduling, skills) — different category from embeddable SDK; integrate only if product direction fits. |
| Tool/auth integration | [Composio](https://composio.dev) | External SaaS toolkits + auth — companion layer, not core search execution. |
| Python-first orchestration | Agno, CrewAI, Pydantic AI, Google ADK | Valid if agent runtime is a separate service; ColdSearch core can remain TS. |
| Node durable compute | [Rivet Actors](https://rivet.dev/) | Stateful workers/queues on Node/Bun — alternative execution substrate, not a research-agent framework. |
| Shared cache / rate limits | Redis | For cross-worker cache and key-pool coordination when more than one worker exists. |
| Explicitly rejected for this epic (for now) | Custom `coldsearchd`, hand-rolled SQLite for jobs/cache/keys, file-cache as multi-worker truth | Single-process JSON cache and JSONL usage are adequate until Epic 5 starts. |

**No framework or stack is chosen.** Hatchet and Inngest are the most discussed fits for `RemoteExecutionBackend` + batch + agent jobs; final pick is a decision at epic kickoff.

## Research notes (June 2026)

Session web research was run while scoping this epic. Redacted `parallel-cli` JSON dumps live under `plans/evidence/2026-06-22-remote-agentic-execution/` as review evidence. The durable summary is here.

### Release snapshot (when research was run)

| Name | Last surfaced activity | Role |
| --- | --- | --- |
| [Vercel AI SDK](https://github.com/vercel/ai) | Jun 18, 2026 (`@ai-sdk/workflow` betas) | TS agent loop / tools; pair with a durable layer |
| [OpenAI Agents SDK JS](https://github.com/openai/openai-agents-js/releases) | Jun 19, 2026 (`v0.11.8`) | TS agents, guardrails, MCP, sessions |
| [LangGraph JS](https://github.com/langchain-ai/langgraphjs/releases) | Jun 17, 2026 (`@langchain/langgraph@1.4.4`) | Explicit graph/state machine for agent steps |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent/releases) | Jun 19, 2026 (`v0.17.0`) | Self-hosted agent **product** (Python-primary), not an embeddable SDK |
| [Mastra](https://github.com/mastra-ai/mastra/releases) | Jun 12, 2026 (`@mastra/core@1.42.x`); npm newer | TS agents + workflows + observability |
| [Inngest](https://github.com/inngest/inngest-js/releases) | May 28, 2026 (`inngest@4.5.0`) | Durable steps / workflows; optional [AgentKit](https://agentkit.inngest.com/) |
| [Trigger.dev](https://www.npmjs.com/package/@trigger.dev/sdk) | Jun 2026 (`4.4.x`) | Durable long-running tasks; hosts agents built elsewhere |
| [Hatchet](https://hatchet.run/) | Active Jun 2026 docs/site | Postgres-backed task DAGs; workers on your infra |
| [Cloudflare Agents](https://developers.cloudflare.com/agents/) | Jun 16–17, 2026 (SDK + platform blog) | Durable agent **runtime on Workers** — platform bet |
| [Google ADK](https://pypi.org/project/google-adk/) | Jun 18, 2026 (`google-adk@2.3.0`; 2.0 GA May 19) | Python graph workflow runtime + multi-agent delegation |
| [Pydantic AI](https://pypi.org/project/pydantic-ai/) | Jun 10, 2026 (`v1.107.0`; `v2.0.0b7` in beta) | Type-safe Python agents; optional Temporal integration |
| [Letta](https://github.com/letta-ai/letta/releases) | Mar 31, 2026 (`v0.16.7`) | Stateful memory platform (formerly MemGPT) — not a job runner |
| [Microsoft Agent Framework](https://devblogs.microsoft.com/agent-framework/) | Apr 2, 2026 (1.0 GA) | .NET + Python enterprise SDK (Semantic Kernel + AutoGen merge) |
| [Inngest AgentKit](https://agentkit.inngest.com/) | Nov 2025 (last npm `@inngest/agent-kit` surfaced) | Durable agent helpers on Inngest — less fresh than core `inngest` SDK |

### Name collisions (read carefully)

- **Hermes Agent** (Nous Research product) ≠ **Nous Hermes** model family ≠ unrelated academic paper [*Hermes: A Large Language Model Framework…*](https://arxiv.org/pdf/2411.06490).
- **Rivet** ([rivet.dev](https://rivet.dev/)) — Actors / agentOS durable Node compute — ≠ legacy visual-programming Rivet (ironcladapp.com) ≠ **Riveter AI** (web data collection) ≠ unrelated marketing product at rivet.app.
- **Composio** — tool/auth integration for agents ([composio.dev](https://composio.dev)); not a search runtime or job orchestrator.
- **Agno** — current name for **Phidata** (rebrand Jan 2025); Python agent framework, not the execution plane.
- **Rivet (ironcladapp.com)** — visual LLM prompt-graph IDE; unrelated to **rivet.dev** Actors.

### Cross-worker infrastructure (when Epic 5 has multiple workers)

- **Redis** — practical for shared rate limiting and cache coordination across workers (atomic counters, TTL keys); BullMQ also depends on it.
- **Inngest self-host** — single binary with SQLite or Postgres backing store; built-in concurrency, throttling, debounce, rate limiting, and `step.sleep` / `step.waitForEvent` without extra worker plumbing.
- **Trigger.dev** — v4 self-host path exists (v3 Docker guide is legacy); evaluate current docs at kickoff.

### Python-side agent runtimes (valid as separate service)

| Name | Notes |
| --- | --- |
| **Agno** (ex-Phidata) | Multi-agent Python framework with tools/RAG; call ColdSearch via HTTP/MCP from a sidecar |
| **Pydantic AI** | FastAPI-ergonomic agents; v2 beta active Jun 2026; has Temporal workflow hooks |
| **Google ADK 2.x** | Graph workflow runtime, Task API for agent delegation; Google-ecosystem tilt |
| **CrewAI** | Role-based agent teams; simpler orchestration, less durable-by-default |

### Memory / state products (orthogonal to job orchestration)

**Letta** (formerly MemGPT) is a **stateful memory platform** — typed memory blocks, session continuity, model swaps — not a substitute for Hatchet/Inngest/BullMQ. Relevant only if Epic 5 needs long-horizon agent memory beyond run-scoped trace IDs (PR5).

### Enterprise / platform-specific (unlikely default for ColdSearch)

- **Microsoft Agent Framework 1.0** — production GA Apr 2026; A2A + MCP defaults; strong for .NET/Azure Foundry shops.
- **LlamaIndex TS** — document/RAG agent workflows; overlaps `extract` differently than fanout search; Python **Llama Agents** repo more active than TS releases in research window.

### Composite stacks worth evaluating (no pick)

| Stack | Shape |
| --- | --- |
| **AI SDK 6** + **Hatchet** or **Trigger.dev** or **Inngest** | Thin TS agent loop; durable batch/agent jobs in the execution plane |
| **LangGraph JS** + **Inngest** | Explicit step graph + durable `step.run` / resume |
| **Inngest** alone (steps, optional AgentKit) | Agent loop as durable functions without a separate agent framework |
| **Mastra** in-process | Batteries-included TS agent + workflows; still needs a remote job story for non-blocking CLI |
| **Hermes Agent** as sidecar/service | ColdSearch tools exposed via API/MCP; Hermes owns memory/scheduling/messaging — **different product category** |

Also on the infra search list: **BullMQ** + Redis (queue-only, roll your own worker agent), **Temporal** (durable workflows at higher ops cost), **Workflow DevKit `DurableAgent`** (pairs with AI SDK 6 for resumable agents).

### Poor fits for ColdSearch specifically

- **Hermes Agent** — strong on persistent personal agent, cron, messaging gateways, browser/shell; weak fit if the product stays a **config-driven search CLI** with normalized `search`/`extract`/`crawl` tools (not a 24/7 operator bot).
- **Claude Agent SDK** — coding-agent tools (Read/Edit/Bash); ColdSearch is not a coding agent.
- **Stagehand** — browser automation for extract; only relevant if agent `fetch` becomes headless-browser-first (today SSRF-guarded HTTP fetch).
- **Cloudflare Agents** — excellent if all-in on Workers; poor fit if ColdSearch must stay **portable CLI + self-hosted workers**.
- **Composio** — only if expanding beyond configured search providers into hundreds of external SaaS tools (not the current north star).

### Execution-plane nuance (from infra research)

- **Hatchet** persists task state in **Postgres**, not Redis; marketed for sub-25ms dispatch to hot workers ([hatchet.run](https://hatchet.run/)).
- **Inngest** emphasizes **step-level checkpointing** (failed step retries without redoing prior LLM/tool steps) and self-host via their CLI/server ([inngest.com](https://www.inngest.com/ai)).
- **BullMQ** is the common **Redis queue + worker** pattern when you want minimal abstraction ([docs.bullmq.io](https://docs.bullmq.io/guide/queues)).
- None of these replace ColdSearch adapters, fanout, or config routing — they only replace homemade daemon/queue/SQLite job state.

## Out of scope for Epic 5 (unless explicitly added)

- Replacing the active local CLI implementation sequence.
- Replacing the active provider-tool surface plan.
- MCP as the primary product interface (tool transport is fine; CLI + job API is the product).

## When to start

Deferred until you explicitly decide to build remote execution. No gate beyond that — finish PR1–PR5 first if you want, but Epic 5 does not block them.

When you start: pick a stack from the table above, record the choice in `docs/ADRs/` before implementing `RemoteExecutionBackend`, then update this plan with the ADR link.
