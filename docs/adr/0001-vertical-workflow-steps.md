# ADR 0001: Vertical workflow-step architecture

- Status: accepted
- Date: 2026-07-13
- Baseline tag: `refactor-baseline-20260713`

## Context

The listing-preparation path was split horizontally across CLI workflows,
contracts, adapters, persistence, and category utilities.
Understanding or changing one business step required following internal imports
through several packages. Attribute mapping needs a stable boundary after
category-attribute retrieval.

## Decision

Business behavior is organized as independently callable packages under
`packages/steps/*`. Every step exposes one public `run...` entry point through
its package root. Shared contracts, transports, and artifact persistence remain
horizontal infrastructure.

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

The active workflow contains exactly five steps and ends at factual attribute
mapping. Future content, publishing, analytics, and UI packages are not retained
as placeholders.

## Baseline and equivalence gate

The real cup workspace for offer `979376199787` and stable CLI metadata were
fingerprinted in `tests/baselines/refactor-baseline.json`. Refactoring is
accepted only when the same artifacts retain those hashes or an explicitly
reviewed semantic-equivalence snapshot replaces them, and all type, test, build,
workflow, and architecture checks pass.
