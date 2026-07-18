---
name: ozon-draft-generation
description: Combine immutable product, category, pricing, AttributeMappingV2, ContentBundleV1, and ImageBundleV1 artifacts into a validated Ozon-shaped ListingDraftV2. This Skill never submits to Ozon.
---

# Draft Generation

Create one `ListingDraftV2` at
`data/runs/<run_id>/07-draft-generation/listing-draft-v2.json`.

Read steps 02–06 through the run manifest. Require a completed
`ContentBundleV1` from step 06. Output `items[]` in the future Ozon
import shape: stable `offer_id`, name from 4180, price, category IDs, package
dimensions, images, primary image, and the unchanged `ozon_attributes` array.

Keep 4191 in `items[].attributes`; do not create a second description or
rewrite it. Do not invent VAT, barcode, old price, stock, a non-CNY currency,
or images.

- Bind the exact SHA-256 of CanonicalProduct, category decision, pricing,
  category attributes, AttributeMappingV2, ContentBundleV1, and ImageBundleV1.
- Bind the current category-tree snapshot and every category-attribute
  snapshot. Missing or expired bindings block publish preflight.
- Preserve `source_sku_id -> offer_id` in `sku_bindings`; the `items[]` wire
  shape itself remains directly usable by `/v3/product/import`.
- A run containing only `listing-draft-v1.json` is legacy and read-only. Start
  a new run; never rewrite or publish it.

- Build, validate, and de-duplicate HTTP(S) `images` first; then set
  `primary_image = images[0]`.
- Use the completed pricing package measurements and final CNY price.
- Validate category-snapshot and dictionary IDs; 10096 must have a real
  `dictionary_value_id`.
- When the snapshot exposes 9048 it must be present. Differing SKU timestamps
  are warnings; do not fabricate 9048 for a category that does not expose it.
- Missing 4180, 4191, price, package data, or images blocks that SKU.

```powershell
pnpm exec tsx apps/cli/src/cli.ts workflow listing prepare "keyword" `
  --run-id <run_id> --stop-after draft-generation --json --pretty
```

This is an internal draft only, not an Ozon upload.
