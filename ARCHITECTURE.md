# Architecture

`auto-ozon-skill` uses vertical business steps over shared TypeScript
infrastructure. Stable package names describe responsibilities; numeric order
appears only in run artifacts.

## Dependency direction

```text
apps/cli
  -> packages/workflows
    -> packages/steps/*
      -> contracts + adapters + artifact-store + core
```

Adapters never import workflows or steps. Steps never import CLI, workflows, or
another step. Cross-package imports use package exports only. These rules are
enforced by `tests/architecture/dependency-boundaries.test.ts`.

## Business steps

Each step exposes one public `run...` function from its package root:

```text
packages/steps/source-1688          runSource1688
packages/steps/canonicalize-product runCanonicalizeProduct
packages/steps/category-decision    runCategoryDecision
packages/steps/category-attributes  runCategoryAttributes
packages/steps/attribute-mapping    runAttributeMapping
packages/steps/draft-generation     runDraftGeneration
```

- `source-1688` validates collection input, delegates browser/search/detail
  work to the 1688 adapter, sanitizes retained facts, and writes `01-source`.
- `canonicalize-product` owns CanonicalProduct V1/V2 conversion, SKU assembly,
  common/varying analysis, integrity checks, and `02-canonical`.
- `category-decision` owns the category Skill, Chinese category tree search,
  exact ID-pair validation, SKU grouping, and `03-category-decision`.
- `category-attributes` owns dynamic category-pair traversal, Chinese attribute
  retrieval, complete dictionary pagination, cache policy, and
  `04-category-attributes`.
- `attribute-mapping` owns factual/dictionary/unit mapping, common/variant/SKU
  classification, the mapping Skill, and `05-attribute-mapping`. Russian copy
  attributes 4180, 4191, and 23171 are deliberately deferred.
- `draft-generation` consumes AttributeMappingV1 plus copy-only Agent input and
  writes the validated `06-draft` output. It never rematches factual values or
  calls an Ozon write API.

`packages/category-intelligence` and `packages/transformer` are compatibility
facades only; new code must use the owning step packages.

## Shared infrastructure

- `packages/contracts`: data-only contracts and step/run statuses.
- `packages/adapters-1688`: login/session/search/image/offers/official-similar
  collection and retained OfferResult codec only.
- `packages/adapters-ozon`: MCP connection, method safety, response parsing, and
  category-attribute transport.
- `packages/artifact-store`: repository root resolution, atomic JSON writes,
  manifests, numbered run directories, cache separation, and secret-safe logs.
- `packages/core`: legacy product-workspace compatibility persistence.
- `packages/workflows`: source command compatibility, category inspect, and the
  resumable `runListingPreparation` orchestrator.

## Run and cache layout

```text
data/runs/<run_id>/
  manifest.json
  01-source/offer-result.json
  02-canonical/canonical-product-v2.json
  03-category-decision/category-decision-v1.json
  04-category-attributes/category-attributes-v1.json
  05-attribute-mapping/attribute-mapping-v1.json
  06-draft/product-draft-v1.json
  logs/workflow.log

data/cache/category-attributes/*.json
```

Manifest statuses are `pending`, `running`, `succeeded`, `needs_review`,
`blocked`, `failed`, and `skipped`. `runListingPreparation` can resume from an
artifact, reuse completed steps, force one step and its downstream dependants,
stop after a selected step, and stop automatically for review.

Legacy `data/products/<offer_id>` artifacts remain available to existing CLI
commands, but workflow evidence and reusable cache data are never mixed.

## Safety and scope

The 1688 engine does not bypass risk control, sliders, or captchas. Similar
search uses only the official similar entry. Supplier research, purchasing,
orders, chat, daemon/background behavior, and automatic publishing are outside
the collection scope. Ozon generic execution remains read-only and locally
blocks write/destructive methods.
