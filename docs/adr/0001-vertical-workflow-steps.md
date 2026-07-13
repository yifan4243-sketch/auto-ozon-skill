# ADR 0001: Vertical workflow-step architecture

- Status: accepted
- Date: 2026-07-13
- Baseline tag: `refactor-baseline-20260713`

## Context

The listing-preparation path was split horizontally across CLI workflows,
contracts, adapters, transformers, publishing storage, and category utilities.
Understanding or changing one business step required following internal imports
through several packages. The next required capability, attribute mapping, also
needs a stable boundary between category attributes and draft generation.

## Decision

Business behavior is organized as independently callable packages under
`packages/steps/*`. Every step exposes one public `run...` entry point through
its package root. Shared contracts, transports, artifact persistence, and agent
runtime remain horizontal infrastructure.

The dependency direction is fixed:

```text
apps/cli -> packages/workflows -> packages/steps/*
packages/steps/* -> contracts + adapters + artifact-store
```

Adapters must not import steps. Contracts must not import implementations.
Steps must not import CLI code or another step's internal files.

Run artifacts use numbered directories under `data/runs/<run_id>` because the
numbers describe execution order rather than stable package identity. Cache
entries live under `data/cache` and are never treated as run evidence.

During this refactor, publishing behavior is frozen. Existing command names and
JSON meanings remain compatible. Compatibility packages may re-export new
public step APIs, but old business implementations are removed after callers
migrate.

## Baseline and equivalence gate

The real cup workspace for offer `979376199787` and stable CLI metadata were
fingerprinted in `tests/baselines/refactor-baseline.json`. Refactoring is
accepted only when the same artifacts retain those hashes or an explicitly
reviewed semantic-equivalence snapshot replaces them, and all type, test, build,
workflow, and architecture checks pass.
