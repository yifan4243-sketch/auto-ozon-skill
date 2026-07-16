---
name: draft-generation
description: Combine completed product, category, pricing, mapping, and 1688 image artifacts into a validated internal Ozon-shaped ListingDraftV1. This Skill never submits to Ozon.
---

# Draft Generation

Create one `ListingDraftV1` at
`data/runs/<run_id>/07-draft-generation/listing-draft-v1.json`.

Read steps 02–06 through the run manifest. Output `items[]` in the future Ozon
import shape: stable `offer_id`, name from 4180, price, category IDs, package
dimensions, images, primary image, and the unchanged `ozon_attributes` array.

Keep 4191 in `items[].attributes`; do not create a second description or
rewrite it. Do not invent VAT, barcode, old price, stock, a non-CNY currency,
or images.

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
