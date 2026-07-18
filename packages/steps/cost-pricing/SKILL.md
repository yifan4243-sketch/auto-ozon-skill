---
name: ozon-cost-pricing
description: Calculate auditable per-SKU CEL shipping, landed cost, Ozon commission, and CNY listing price after category decision and before Ozon category-attribute retrieval.
---

# Cost Pricing

Produce one `CostPricingV1` from CanonicalProductV2, a decided CategoryDecisionV1,
the bundled commission snapshot, the current run's fixed CBR CNY/RUB rate, and an
optional Agent package estimate.

## Workflow

1. Prefer complete, plausible per-SKU 1688 package facts with a known `g` or `kg` unit.
2. When facts are missing or implausible, return `agent_tasks`; the current Agent estimates
   one sellable unit's packaged weight and dimensions without calling a model API.
3. Apply a 20% buffer to Agent-estimated weight only. Never treat Ozon net-weight attribute
   4383 as packaged weight.
4. Enumerate the effective CEL groups, calculate land shipping by default, compute landed
   cost, set CNY price to rounded `landed_cost × 2`, convert to RUB, and retain only a
   self-consistent CEL price band.
5. Resolve the Ozon commission by description-category ID and final RUB price.
   In default `multiplier` mode commission affects projected profit, not price.
   In `target_margin` mode commission and all configured rates participate in
   the self-consistent segmented price solver.
6. Write only `04-cost-pricing/cost-pricing-v1.json`.

Every completed SKU also embeds `CostModelV2` and `PriceDecisionV2`. Monetary
calculation uses integer micro-CNY internally; the V2 audit objects preserve
those integer strings, snapshot hashes, solver mode and achieved margin.

Use `--pricing-agent-stdin` to return Agent estimates. Do not add price, package dimensions,
or shipping rules to attribute-mapping.
