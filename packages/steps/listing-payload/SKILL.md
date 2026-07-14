---
name: ozon-listing-payload
description: Build and validate a deterministic Ozon /v3/product/import payload from a publish-ready V2 draft, CanonicalProductV2 and StorePublishProfileV1 without calling Ozon.
---

# Ozon Listing Payload

Use this step only after `product-draft-v2.json` is `publish_ready`.

1. Resolve the CanonicalProductV2, draft, current snapshot digests and store
   profile from the Manifest V2 run.
2. Call `runListingPayload`; do not hand-author Seller API items.
3. Stop on missing purchase price, multiplier, VAT, dimensions, explicit
   packaged weight, source image URL or variant coverage.
4. Persist `07-listing-payload/listing-payload-v1.json` through the artifact
   store. Do not submit it from this step.

Price currency is CNY. Offer IDs must remain stable across reruns. Images must
be existing CanonicalProduct 1688 URLs. Never estimate weight, create images,
emit stock, expose credentials or use a generic Ozon call bridge.
