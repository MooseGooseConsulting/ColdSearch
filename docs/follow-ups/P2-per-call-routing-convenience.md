# P2 (optional) — Per-call routing convenience (draft for GitHub issue)

**Status:** draft — optional; file only if the main follow-ups land cleanly.

## Problem

The CLI already supports per-call provider selection with `--providers LIST`,
including a singleton such as `--providers exa`. `--single-provider` instead
chooses one provider from the eligible pool with quota failover. The remaining
gap is provider preference ordering, not a missing provider selector.

## Options (pick one after usage feedback)

1. Document `--providers <id>` as the existing way to restrict one call to a
   single provider.
2. Consider `--prefer <id[,id]>`: try preferred providers first, then fall
   back to the configured pool on failure (provenance records the preference).
3. Do nothing: keep routing config-level beyond the existing per-call
   `--providers` selector to avoid flag sprawl.

## Done when

- [ ] Decision recorded (document the existing selector, implement preference
      ordering, or explicitly decline with rationale).
- [ ] If implemented: pre-call rejection when `--prefer` ids are not in the
      configured pool or lack the intent's required features.
