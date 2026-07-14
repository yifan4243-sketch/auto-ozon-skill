---
name: auto-ozon-skill
description: Route the repository's current five-step 1688-to-Ozon attribute workflow. Use when collecting a 1688 product, normalizing it, deciding its Ozon category, retrieving category attributes, or filling validated factual attributes.
---

# Auto Ozon Skill Router

Keep workflow artifacts under `data/runs/<run_id>/` and read that run's
`manifest.json` before resolving stage files.

Use the specialized skill for the requested stage:

- Category selection or SKU grouping: read
  `packages/steps/category-decision/SKILL.md`.
- Factual Ozon attribute mapping: read
  `packages/steps/attribute-mapping/SKILL.md`.

Do not copy these skills into a run workspace. The current workflow ends at
`attribute-mapping`; do not build drafts, prices, upload payloads, or publish.
