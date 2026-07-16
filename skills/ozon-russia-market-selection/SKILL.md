---
name: ozon-russia-market-selection
description: Select diversified Russian Ozon market opportunities from the saved annual category analytics snapshot before sourcing on 1688. Use when asked what to sell on Ozon, which Ozon categories have room for small sellers, which category names to search on 1688, or how to allocate a store's daily listing limit across 5 to 10 categories.
---

# Ozon Russia Market Selection

Use the saved yearly category snapshot as the market fact source. Select
categories, not individual products. This is a pre-sourcing step; it produces a
diversified 1688 sourcing plan and never publishes a listing.

## Input and output

1. Find the newest `data/ozon/category-analytics/raw/ozon-category-year-*.json`.
   Do not call its original upstream endpoint, reuse its cookies, or expose its
   company ID, request logs, or errors.
2. Read only completed level-3 rows with a category ID, Chinese category name,
   GMV, sold items, average item value, seller count, buyout rate, leader share,
   and growth fields.
3. Write `data/runs/<batch_id>/00-market-selection/market-selection-v1.json`.
   It is a batch planning artifact, not a normal product-run manifest.
4. Read [references/selection-policy.md](references/selection-policy.md) and
   [references/russia-seasonality.md](references/russia-seasonality.md) before
   ranking categories.

## Selection workflow

### 1. Exclude unsuitable categories

Reject Fresh food, ordinary food, pharmacy, adult goods, smoking goods,
services, charity, books, and categories whose product normally requires local
certification, expiry control, cold chain, batteries, liquids, oversized
shipping, or brand authorization. Reject a category if the saved facts are
missing or clearly incomplete. Record every rejection reason.

Do not reject a category merely because it is not a top-GMV category. The goal
is viable small-seller opportunity, not maximum market size.

### 2. Score viable level-3 categories

Calculate relative percentiles within the viable level-3 candidate set. Use the
following transparent score, clamped to 0–100:

```text
score =
  25 × demand_percentile(metric_gmv)
+ 15 × demand_percentile(metric_items)
+ 15 × positive_growth_percentile(metric_gmv_growth)
+ 20 × (1 - metric_leader_share / 100)
+ 10 × buyout_rate / 100
+ 10 × moderate_competition_score(metric_sellers)
+  5 × long_tail_opportunity_bonus
+ seasonal_adjustment(-10 to +10)
```

`moderate_competition_score` rewards seller counts in the middle range. A tiny
seller count can indicate a closed or impractical category; an extreme seller
count means intense price competition. `long_tail_opportunity_bonus` applies
only to categories with real demand and positive growth that are not in the
top GMV tier. Never fabricate a metric that is blank in the snapshot.

### 3. Apply Russia seasonal and living-context review

Use the current calendar date and the seasonal guide only as a bounded
adjustment. Give a category a positive adjustment only when its product use is
directly supported by the season or an upcoming Russian public holiday. Do not
claim current weather without a weather data source. Explain every adjustment
in plain Chinese.

### 4. Create a diversified launch plan

Choose 5–10 categories, defaulting to 8. Do not select more than two categories
under one level-1 root. Rank by score but retain a mix of demand and long-tail
opportunities. Respect the store's daily limit of 100 listings:

- Default allocation: 8 categories × 12 target products = 96 listings.
- For 5–7 categories: at most 15 listings per category.
- For 9–10 categories: at most 10 listings per category.
- The sum of `planned_listings` must be at most 100.

For each selected category use its saved Chinese `category_name` exactly as the
primary 1688 search keyword. Do not translate or invent a different initial
keyword. A later Agent may add related Chinese words only after the exact-name
search returns too few viable products, and must record that fallback.

### 5. Hand off to 1688 sourcing

Create one sourcing queue item per selected category. Each item contains the
exact Chinese category keyword, planned listing count, maximum SKU count, and
the selection rationale. Run existing 1688 collection separately for each
queue item; do not mix categories into one product run.

Use more candidates than the planned listing count because downstream pricing,
attributes, images, and compliance checks can reject products. Stop sourcing a
category once it has enough `draft_complete` products for its allocation. Do
not publish from this Skill.

## Required artifact shape

```json
{
  "schema_version": 1,
  "batch_id": "market-20260716-001",
  "snapshot": { "path": "...", "sha256": "...", "captured_at": "..." },
  "selection_date": "YYYY-MM-DD",
  "daily_listing_limit": 100,
  "planned_listing_total": 96,
  "selected_categories": [
    {
      "analytics_category_id": 0,
      "category_path_zh": "",
      "search_keyword_1688_zh": "",
      "score": 0,
      "metrics": { "gmv": 0, "items": 0, "growth_percent": 0, "seller_count": 0, "buyout_percent": 0, "leader_share_percent": 0 },
      "seasonal_adjustment": 0,
      "rationale_zh": "",
      "planned_listings": 12,
      "candidate_collection_target": 24
    }
  ],
  "rejected_categories": [{ "analytics_category_id": 0, "reason": "" }]
}
```

## Boundaries

- Treat the snapshot as historical evidence, not a guarantee of future sales.
- Keep Ozon market selection separate from later Ozon category decision. The
  latter maps a concrete 1688 product to an upload category and must not be
  influenced by GMV popularity.
- Never use sales rank alone. Low leader share, feasible logistics, positive
  demand, and diversity are required together.
- Do not use competitor scraping, risk-control bypasses, proxies, or automated
  purchasing.
- Never exceed the configured daily listing limit, and do not submit products
  until all existing downstream validation steps succeed.
