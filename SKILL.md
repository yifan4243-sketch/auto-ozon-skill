---
name: auto-ozon-skill
description: Route the repository's 1688-to-Ozon workflow. Use when collecting a 1688 product, deciding its Ozon category, retrieving category attributes, generating a validated Ozon draft, or locating the specialized repository skill for one of those stages.
---

# Auto Ozon Skill Router

Keep workflow artifacts under `data/runs/<run_id>/` and read that run's
`manifest.json` before resolving stage files.

Use the specialized skill for the requested stage:

- Category selection or SKU grouping: read
  `packages/steps/category-decision/SKILL.md`.
- Factual Ozon attribute mapping: read
  `packages/steps/attribute-mapping/SKILL.md`.
- Russian copy and draft generation: read
  `packages/steps/draft-generation/SKILL.md`.

Do not copy these skills into a run workspace. Do not continue to draft
generation until the category decision and category-attribute snapshot exist.
