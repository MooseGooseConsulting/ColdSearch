# Routing and Request Policy

## Routing (Current)

Operators configure provider pools per capability in `config.toml`. The runtime:

1. Validates the capability and configured providers.
2. Resolves API keys (explicit env refs, Doppler CLI refs/defaults, or keyless providers). `bws:` references are rejected with migration guidance. For provider keys already injected by `doppler run`, use an `env:` reference; provider `doppler:` references currently still invoke the CLI.
3. Selects from the pool (random or fanout per config).
4. Does not silently hop to another provider after selection.

See `docs/ADRs/001-fanout-architecture.md` and `docs/CONFIGURATION.md`.

## Request lifecycle (Current)

All networked operations use shared request handling:

- explicit timeouts
- abort control
- bounded transient retries
- normalized error reporting

Applies to provider adapters and agent LLM calls. Agent LLM uses OpenAI-compatible endpoints only; ColdSearch does not call Anthropic APIs.
