---
name: auto-ozon-skill
description: Route the repository's 1688-to-Ozon listing workflow. Use when collecting a 1688 product, calculating price, selecting an Ozon category, filling attributes, generating a listing draft, submitting to Ozon, or configuring a customer's local store and workflow preferences.
---

# Auto Ozon Skill Router

Keep workflow artifacts under `data/runs/<run_id>/` and read that run's
`manifest.json` before resolving stage files.

Use the specialized skill for the requested stage:

- Category selection or SKU grouping: read
  `packages/steps/category-decision/SKILL.md`.
- Factual Ozon attribute mapping: read
  `packages/steps/attribute-mapping/SKILL.md`.
- Customer store, SKU, price, retry, or publish configuration: read
  `skills/customer-setup/SKILL.md`.

Do not copy these skills into a run workspace. The ordered workflow is
`source-1688`, `canonicalize-product`, `category-decision`, `cost-pricing`,
`category-attributes`, `attribute-mapping`, `draft-generation`, and
`listing-submit`. Publishing requires an explicitly enabled local store profile.
