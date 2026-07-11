---
name: ozon-category-decision
description: Classify a CanonicalProductV2 from 1688 into validated Ozon category groups. Use when selecting an Ozon description category and type, distinguishing normal SKU variants from mixed products, checking complete SKU coverage, or producing a CategoryDecisionV1 before Ozon attribute retrieval.
---

# Ozon Category Decision

Produce one auditable `CategoryDecisionV1` from one `CanonicalProductV2`. Let AI
make the semantic decision; use repository code to search and validate category
IDs. Do not infer IDs or use category analytics.

## Workflow

1. Reject unsafe input.
   - If `validation.status` is `blocked`, return a blocked decision.
   - Treat every `source_sku_id` as an identity. Never drop or merge an ID.
2. Read evidence in this order:
   - `source.discovery_context.search_term`
   - `product.title_zh`
   - `source.source_category_path_zh`
   - `product.attributes`
   - SKU `specs`, `raw_spec_text`, and images
3. Classify the product structure.
   - `single_sku`: one normalized SKU.
   - `normal_variants`: the same product function with color, size, length,
     capacity, style, or package variations.
   - `mixed_product`: SKUs represent different product functions or Ozon types.
   - `unclear`: source evidence cannot safely distinguish the structures.
4. Select representatives.
   - Use the only SKU for a single-SKU product.
   - For normal variants, choose the SKU with the most complete specs, image,
     and package evidence; break ties by input order.
   - For a mixed product, choose at least one representative from each group.
5. Search the saved Ozon tree from the repository root. Search short semantic
   nouns, not the full title. Run several searches when synonyms are plausible.

   ```powershell
   pnpm --filter @auto-ozon/category-intelligence category:lookup search "智能手机壳" --limit 20
   pnpm --filter @auto-ozon/category-intelligence category:lookup search "保护套" --limit 20
   ```

6. Compare candidates by product function. Reject accessory, replacement-part,
   child/adult, disposable/reusable, powered/manual, and material-specific types
   unless source evidence supports them.
7. Validate the selected pair. A `type_id` alone is never sufficient because the
   saved tree contains repeated type IDs.

   ```powershell
   pnpm --filter @auto-ozon/category-intelligence category:lookup validate `
     --description-category-id 17028650 --type-id 97011
   ```

8. Output JSON matching `output.schema.json`. Use exact names and the complete
   path returned by the validator. Save the product and decision JSON, then run
   the complete schema, category-pair, and SKU-coverage check:

   ```powershell
   pnpm --filter @auto-ozon/category-intelligence category:decision validate `
     --product <canonical-v2.json> --decision <category-decision.json>
   ```

## Coverage and status rules

- Assign every source SKU exactly once to one category group or to
  `unassigned_sku_ids`.
- Use one group for normal variants. Use at least two groups for a mixed product.
- Set `decided` only when every SKU is assigned and every selected pair validates.
- Set `needs_review` when SKU grouping is complete but category evidence is
  ambiguous. Keep up to three validated alternatives and explain the ambiguity.
- Set `blocked` for blocked source data, unknown or duplicate SKU coverage,
  unassigned SKUs, or invalid/disabled category pairs.
- Preserve uncertainty. Never select between indistinguishable Ozon nodes by ID
  order, popularity, GMV, or guesswork.

## Prohibited behavior

- Do not invent, translate, renumber, or repair category IDs.
- Do not read `data/ozon/category-analytics` for classification.
- Do not retrieve Ozon attributes, write Russian copy, price, ship, draft, or
  publish products.
- Do not change CanonicalProductV2 source facts.

See `examples/` for single-SKU, normal-variant, and mixed-product decisions.
