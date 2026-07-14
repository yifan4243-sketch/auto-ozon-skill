---
name: attribute-mapping
description: Map CanonicalProductV2 facts, a validated CategoryDecisionV1, and current Ozon CategoryAttributesV1 snapshots into auditable common attributes, variant attributes, and complete per-SKU attribute assignments. Use when filling Ozon category attributes, selecting dictionary values, separating shared values from SKU differences, identifying missing required attributes, or producing the final AttributeMappingV1 artifact.
---

# Attribute Mapping

Produce one `AttributeMappingV1` without generating copy or an upload payload.
Let deterministic code preserve facts and validate dictionaries; use Agent input
only for semantic selections that source facts cannot establish.

## Workflow

1. Read the product, category decision, and every category-attribute snapshot.
2. Stop when upstream data is blocked, SKU coverage is incomplete, or a group
   lacks exactly one snapshot matching its description-category/type pair.
3. Read [references/mapping-policy.md](references/mapping-policy.md).
4. Produce Agent selections only for attributes that deterministic matching
   cannot resolve. Preserve each `source_sku_id` and select dictionary IDs only
   from the matching current snapshot.
5. Call `runAttributeMapping`; do not hand-author `common_attributes`,
   `variant_attributes`, or final `sku_attributes`.
6. Save output matching `output.schema.json` as
   `05-attribute-mapping/attribute-mapping-v1.json`.

## Boundaries

- Never change CanonicalProductV2 facts.
- Never invent a dictionary ID or silently repair an Agent value.
- Mark low-confidence Agent selections `needs_review`.
- Block missing required attributes and invalid dictionary selections.
- Do not generate Russian names, descriptions, hashtags, price, stock, media,
  logistics dimensions, or publishing requests in this step.
- Attributes 4180, 4191, and 23171 are content fields outside the current
  factual-mapping workflow and do not block `AttributeMappingV1`.

See `examples/common-and-variant.output.json` for the required relationship
between common, variant, and per-SKU arrays.
