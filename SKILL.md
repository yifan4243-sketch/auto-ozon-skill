---
name: auto-ozon-skill
description: Route the repository's eight-step 1688-to-Ozon workflow. Use when collecting a 1688 product, deciding its Ozon category, retrieving and mapping attributes, generating a validated Ozon draft, building an import payload, publishing, or resuming a Manifest V2 run.
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

The host Agent performs semantic category selection, attribute selection and
Russian copy generation using its own LLM. This Skill must not install or call a
model provider. Repository code validates the Agent's structured output against
source evidence, the current Ozon snapshot and JSON Schema.

Only a `publish_ready` V2 draft may enter `listing-payload`. Direct Ozon writes
must go through `ozon-publish`; keep the generic `ozon call` bridge read-only.
Never create inventory calls, placeholder images, deletion, archive, rollback,
daemon or background behavior.
