---
name: auto-ozon-skill
description: Route the repository's 1688-to-Ozon workflow. Use when collecting a 1688 product, deciding its Ozon category, retrieving category attributes, generating a validated Ozon draft, or locating the specialized repository skill for one of those stages.
---

# Auto Ozon Skill Router

Keep product artifacts under `data/products/<offer_id>/` and read that
workspace's `manifest.json` before resolving stage files.

Use the specialized skill for the requested stage:

- Category selection or SKU grouping: read
  `packages/category-intelligence/skills/ozon-category-decision/SKILL.md`.
- Ozon attribute mapping or draft generation: read
  `packages/transformer/skills/ozon-draft-generation/SKILL.md`.

Do not copy either skill into a product workspace. Do not continue to draft
generation until the category decision and category-attribute snapshot exist.
