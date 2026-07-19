---
name: ozon-listing-submit
description: Submit a validated ListingDraftV2 to one explicitly selected Ozon store, poll import tasks, reconcile ambiguous submissions, interpret per-SKU results, and resume safely. Use for workflow listing publish, resume, status, Ozon product-import failures, task polling, or idempotent recovery after an uncertain response.
---

# Ozon Listing Submit

Submit only the unchanged `items[]` from a current `draft_complete`
`ListingDraftV2`. Resolve every artifact through
`data/runs/<run_id>/manifest.json`; never read a guessed attempt directory.

## Publish workflow

1. Require an explicit `--store-id`, a matching local StoreProfileV2,
   `publishing.enabled=true`, valid local credentials, and an active unrevoked
   StorePublishingConsentV1 bound to the current profile hash.
2. Run publish preflight. Require current artifact hashes, category snapshots,
   CNY currency, images, attributes and daily-limit capacity. Attribute 4191
   must exist and contain no Chinese, Japanese, Korean, or unsafe control
   characters.
3. Submit only through the typed listing adapter to `/v3/product/import`.
   Never use arbitrary URLs or the generic `ozon call` bridge for a write.
4. Treat Ozon `result.task_id` as an opaque identifier. The API may return a
   JSON number; repository code normalizes it to a string before persistence.
5. Poll `/v1/product/import/info`, preserve partial successes, and retry only
   explicitly recoverable failed SKUs up to the configured maximum of two.
6. Confirm successful offer IDs with `/v3/product/info/list` before recording
   `product_id`. Do not invent a product URL.

```powershell
pnpm exec tsx apps/cli/src/cli.ts workflow listing publish `
  --run-id <run_id> --store-id <Client-Id> --json

pnpm exec tsx apps/cli/src/cli.ts workflow listing resume `
  --run-id <run_id> --store-id <Client-Id> --json

pnpm exec tsx apps/cli/src/cli.ts workflow listing status `
  --run-id <run_id> --json
```

## Result semantics

- `imported`: Ozon confirmed this task item and product lookup returned its ID.
- `skipped` with non-null `product_id`: successful idempotent reuse or remote
  reconciliation. Count it as a successful listing.
- `skipped` without `product_id`: not a confirmed success.
- `polling_timeout`: the write may already be accepted. Run `resume`; never
  issue a fresh publish merely because foreground polling ended.
- `failed`: inspect the saved per-SKU errors. Retry only when the repository
  marks the error recoverable.
- `partial_failed`: keep confirmed successes and handle only failed SKUs.
- `blocked`: fix preflight, consent or configuration; no write was authorized.

If a process stops after Ozon accepts a request but before `task_id` is saved,
treat the submission as ambiguous. Reconcile by `offer_id` and any persisted
task before retrying. Existing remote products with matching offer IDs and
confirmed IDs are recorded as `skipped + product_id`; do not duplicate them.

## Boundaries

- Do not manage inventory. `Готов к продаже` with no stock means the card is
  approved but not currently sellable; report that distinction accurately.
- Do not delete, archive, deactivate or roll back products.
- Never log API keys, headers, cookies or complete local environment values.
- Real Seller writes require explicit customer authorization and are never a
  test, smoke check, fixture refresh or documentation-validation step.
