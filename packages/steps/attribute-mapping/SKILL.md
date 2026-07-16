---
name: ozon-attribute-mapping
description: Map CanonicalProductV2 facts, a validated CategoryDecisionV1, and current Ozon CategoryAttributesV1 snapshots into auditable common attributes, variant attributes, and complete per-SKU attribute assignments. Use when filling Ozon category attributes, selecting dictionary values, separating shared values from SKU differences, identifying missing required attributes, or producing the final AttributeMappingV1 artifact.
---

# Attribute Mapping

Produce one `AttributeMappingV1` that merges deterministic values and the
current Agent's semantic selections. Do not call an external model runtime.

## Workflow

1. Read the product, category decision, and every category-attribute snapshot.
2. Stop when upstream data is blocked, SKU coverage is incomplete, or a group
   lacks exactly one snapshot matching its description-category/type pair.
3. Read [references/mapping-policy.md](references/mapping-policy.md).
4. Run `runAttributeMapping` without Agent input first when necessary. Read its
   `agent_tasks` from the single output artifact.
5. As the current Agent, answer every task from retained 1688 facts. Select
   dictionary IDs only from `dictionary_candidates`; do not call any model API.
6. Rerun through `workflow listing prepare --attribute-agent-stdin` and pipe the
   compact Agent JSON to stdin. `--attribute-agent-json` remains available for
   small inputs.
   Do not hand-author common, variant, or Ozon-ready arrays.
7. Save output matching `output.schema.json` as
   `06-attribute-mapping/attribute-mapping-v1.json`.

## Boundaries

- Never change CanonicalProductV2 facts.
- Never invent a dictionary ID or silently repair an Agent value.
- Reuse the completed cost-pricing SKU weight for 4383 and derive 4497 as
  `4383 + 50g`. A fallback Agent-estimated net weight must exceed 3g and remains
  low-confidence.
- Block missing required attributes and invalid dictionary selections.
- Generate Russian attributes 4180, 4191, and 23171 exactly as specified in the
  mapping policy. Offer all remaining non-system attributes to the Agent, but do
  not generate price, stock, media, dimensions, compliance codes, or a publish
  request without retained facts.

See `examples/common-and-variant.output.json` for the required relationship
between common, variant, and per-SKU arrays.

Example finalization command:

```powershell
$agentJson | pnpm exec tsx apps/cli/src/cli.ts workflow listing prepare "keyword" `
  --run-id <run_id> --start-from attribute-mapping --stop-after attribute-mapping `
  --attribute-agent-stdin
```
