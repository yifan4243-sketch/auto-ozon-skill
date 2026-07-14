---
name: ozon-publish
description: Submit a validated ListingPayloadV1 to Ozon, poll the import task in the foreground and record per-SKU confirmed results through the typed Seller adapter.
---

# Ozon Publish

Use this step only when the store profile has `publishing.enabled: true` and
the preceding payload is valid.

1. Resolve credentials from the profile's reference outside run artifacts.
2. Call `runOzonPublish` with the strongly typed Seller write transport.
3. Submit `/v3/product/import`, poll `/v1/product/import/info`, retain partial
   successes and retry only recoverable failed SKU items at most twice.
4. Resolve confirmed product/SKU identities before recording a product link.
5. Persist `08-ozon-publish/ozon-publish-result-v1.json`.

Never log credentials or headers. Never invoke stock, delete, archive, rollback
or background APIs. Tests must inject a fake transport and must never write to a
real store.
