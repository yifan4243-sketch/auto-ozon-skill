---
name: ozon-draft-generation
description: Generate and validate OzonProductDraftV1 from a 1688 product workspace after category selection and category-attribute retrieval. Use when mapping CanonicalProductV2 facts to Ozon attributes, choosing dictionary values, generating Russian names, descriptions, and hashtags, estimating or converting net weight, validating complete SKU coverage, or preparing draft.json and validation.json without uploading to Ozon.
---

# Ozon Draft Generation

Create an auditable draft from one product workspace. Let the Agent make
semantic choices and let repository code enforce identities, dictionary IDs,
formulas, coverage, and status.

## Workflow

1. Read `data/products/<offer_id>/manifest.json` and resolve these artifacts:
   - `1688_data/source.json`
   - `1688_data_v2/product.json`
   - `ozon_draft/category_decision.json`
   - `ozon_draft/category_attributes.json`
2. Stop with `blocked` when the CanonicalProductV2 or CategoryDecisionV1 is
   blocked, a selected category is absent, a SKU is unassigned, or an attribute
   snapshot does not match its `description_category_id + type_id` pair.
3. Read [common-attribute-rules.md](references/common-attribute-rules.md) before
   choosing any Ozon value. Read
   [copy-generation-rules.md](references/copy-generation-rules.md) before
   generating Russian copy.
4. Produce one `OzonDraftAgentSkuInputV1` for every source SKU. Supply an
   estimated gram weight only when CanonicalProductV2 has no usable gram or
   kilogram value. Preserve each `source_sku_id`.
5. Pass the product, category decision, attribute snapshots, and Agent input to
   `buildOzonProductDraft`. Never hand-author the final attribute array when the
   mapper can build it.
6. Match `output.schema.json`. Save the returned draft and validation report as
   `ozon_draft/draft.json` and `ozon_draft/validation.json` through the existing
   publishing store.

## Decision rules

- Select dictionary values only from the current category snapshot. Treat the
  fixed IDs in the reference as candidates that still require validation.
- Record evidence, confidence, and one provenance value for every mapped
  attribute: `source`, `converted`, `agent_estimated`, `derived`, or `default`.
- Keep CanonicalProductV2 immutable. Unit conversion and Agent estimates belong
  only in the draft.
- Use `needs_review` for Agent-estimated weight, low-confidence choices, or an
  upstream review status. Use `blocked` for missing SKU coverage, invalid
  dictionaries, missing supported required values, or an unexpected unsupported
  required attribute.

## Output boundaries

Match `output.schema.json`. Examples for single-SKU, normal-variant, and mixed
products are in `examples/`.

Do not calculate price, VAT, or stock. Do not fill top-level logistics
dimensions. Do not call an Ozon write method, create a product, upload media, or
store credentials in a skill or product artifact.
