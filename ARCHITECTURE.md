# Architecture

`auto-ozon-skill` is a pnpm workspace using TypeScript and Node.js 20+.

## Current implemented slice

The 1688 sourcing engine is migrated from `superjack2050/1688-cli` into `packages/adapters-1688/src/engine`.

```text
apps/cli
  auto-ozon command surface
  complete Ozon MCP command registration

packages/contracts
  CommandResult, CanonicalProduct V1, CanonicalProductV2, SourcingResult

packages/transformer
  deterministic SKU specification parsing
  per-SKU package assembly
  common/varying source-field comparison
  source variant-dimension analysis

packages/adapters-1688
  engine/auth
  engine/session
  engine/commands
  mappers
  client.ts

packages/adapters-ozon
  TypeScript bridge to vendor/ozon-mcp
  discovery tools
  reference tools
  subscription tools
  workflows
  guarded read-only execution
```

The session layer is inline-only. It uses Playwright persistent browser contexts, profiles, cookies, locks, events, artifacts, response capture, mtop capture, and recovery. The daemon logic from the source project is intentionally deleted.

## Ozon MCP bridge

`packages/adapters-ozon` starts the external `vendor/ozon-mcp` server over MCP stdio. The Python implementation remains in the submodule; this repository only contains a typed TypeScript bridge.

The TypeScript bridge has wrappers for the complete 15-tool PCDCK surface:

```text
ozon_call_method
ozon_fetch_all
ozon_describe_method
ozon_search_methods
ozon_list_sections
ozon_get_section
ozon_list_workflows
ozon_get_workflow
ozon_get_related_methods
ozon_get_examples
ozon_get_rate_limits
ozon_get_subscription_status
ozon_list_methods_for_subscription
ozon_get_swagger_meta
ozon_get_error_catalog
```

Runtime registration in `PCDCK/ozon-mcp` is credential-aware:

- 12 discovery, workflow, graph, and reference tools are always available.
- `ozon_call_method` and `ozon_fetch_all` appear when Seller or Performance credentials are configured.
- `ozon_get_subscription_status` appears only when Seller credentials are configured.

`ozon doctor` validates those three groups separately, so an offline installation is not incorrectly reported as broken merely because credential-dependent tools are absent.

Every wrapper returns the shared `CommandResult` envelope, sanitizes credential values from errors, and converts MCP error payloads into structured local errors.

Generic execution remains intentionally read-only. Before `ozon_call_method` or `ozon_fetch_all` is invoked, the adapter describes the target operation and only proceeds when its MCP safety classification is `read`. `write` and `destructive` methods return `OZON_WRITE_BLOCKED` locally.

## Sourcing pipeline

```text
keyword / image / offerIds / similar
-> 1688 collection
-> offer detail collection through offers
-> CanonicalProduct
-> later Ozon draft transformation
```

`search` always performs detail collection by default. The former optional deep mode is now the normal behavior needed for Ozon listing preparation.

## CanonicalProductV2 source-fact pipeline

V1 remains the contract used by the current source commands. The independent V2
mapper adds a non-breaking phase-one pipeline:

```text
1688 OfferResult
-> offerToCanonicalV2
-> CanonicalProductV2.skus (complete per-SKU source facts)
-> CanonicalProductV2.sku_analysis (common, varying, missing, duplicate specs)
```

Each source SKU owns an independent package object. Matching uses exact SKU ID,
then normalized exact specification text, and otherwise produces null package
facts with `matched_by = "none"`. Raw weights retain their source value and use
`weight_unit = "unknown"` unless the source explicitly supplies a recognized
unit.

This layer stops before marketplace interpretation. Agent classification, Ozon
category and attribute retrieval, missing-package policy, freight, pricing,
Russian copy, Ozon internal drafts, and final `items[]` are downstream work.

## Removed scope

Cart, checkout, order, seller chat, supplier research, research, compare, feedback, procurement, and automatic purchasing are intentionally excluded.
