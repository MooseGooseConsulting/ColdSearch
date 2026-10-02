# Routing and Request Policy

## Routing (Current)

Operators configure provider pools per capability in `config.toml`. The runtime:

1. Validates the capability and configured providers.
2. Selects from the eligible capability pool (or the caller's `--providers`
   override), using random or all mode per config.
3. Resolves keys for attempted providers (`doppler:` / `env:` refs, literal
   keys, or keyless providers).
4. Random/`--single-provider` normally executes one provider. Account-quota
   exhaustion enables recovery through the remaining eligible providers in
   pool order, once each, until one succeeds. Recovery is visible in errors,
   usage logs, and history; it never rewrites pools or key configuration.
5. In `all` mode, search isolates errors across parallel calls; extract/crawl
   try providers in order until one succeeds. If none succeeds, all attempted
   provider errors remain available.

Only account exhaustion initiates random-mode recovery; other initial failures
remain visible. Explicit singleton scopes and provider-native tool calls have
no cross-provider alternative. No preflight balance probe or persistent quota
gate is implemented. See [quota recovery](../CONFIGURATION.md#quota-recovery)
for detection and scope details.

See `docs/ADRs/001-fanout-architecture.md` and `docs/CONFIGURATION.md`.

## Request lifecycle (Current)

All networked operations use shared request handling:

- explicit timeouts
- abort control
- bounded transient retries
- normalized error reporting

Applies to provider adapters and agent LLM calls. Agent LLM uses OpenAI-compatible endpoints only; ColdSearch does not call Anthropic APIs.
