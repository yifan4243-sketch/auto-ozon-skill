# Cost Pricing Step

This step runs after Ozon category decision and before category-attribute retrieval. It owns
the effective CEL tariff table, CBR CNY/RUB rate snapshot, commission lookup, package fact
selection, Agent estimate audit, landed cost, and final integer CNY listing price.

Default profile: land transport, one source item per sellable unit, CNY 2 label fee, 10%
other variable cost, and listing price equal to rounded landed cost multiplied by two.

Output: `data/runs/<run_id>/04-cost-pricing/cost-pricing-v1.json`.
