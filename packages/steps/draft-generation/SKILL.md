---
name: ozon-draft-generation
description: Generate validated OzonProductDraftV1 from an existing AttributeMappingV1 plus Russian copy input. Use after factual Ozon attributes have already been mapped, when creating Russian names, descriptions, hashtags, per-SKU draft items, or the 06-draft artifact without uploading to Ozon.
---

# Ozon Draft Generation

Create an auditable draft without rematching source facts or calling an Ozon
write API. `AttributeMappingV1` is the only source of factual Ozon attributes;
the Agent supplies Russian copy only.

## Workflow

1. Read the run manifest and resolve:
   - `04-category-attributes/category-attributes-v1.json`
   - `05-attribute-mapping/attribute-mapping-v1.json`
2. Stop if attribute mapping is blocked or SKU coverage is incomplete.
3. Read [copy-generation-rules.md](references/copy-generation-rules.md).
4. Produce one copy input for every mapped `source_sku_id`:
   - Russian name;
   - Russian description;
   - 20-30 unique Russian hashtags;
   - confidence and evidence for each value.
5. Call `runDraftGeneration`. Do not hand-author final attribute arrays.
6. Save output matching `output.schema.json` as
   `06-draft/product-draft-v1.json`.

## Boundaries

- Never change `AttributeMappingV1` or select a new dictionary value here.
- Attributes 4180, 4191, and 23171 belong to this copy step; factual and
  variant attributes belong to attribute-mapping.
- Preserve every `source_sku_id`, group ID, description category ID, and type ID.
- Use `needs_review` for low-confidence copy or an upstream review state.
- Use `blocked` for missing/duplicate SKU copy, invalid Russian copy, or a
  blocked attribute mapping.
- Do not calculate price, VAT, stock, or logistics dimensions. Do not create or
  update an Ozon product and do not store credentials.
