# AGENTS

This repository uses TypeScript, Node.js 20+, and pnpm workspace. Do not add Python or mixed-language rewrites for the 1688 collection engine.

## 1688 sourcing rules

- The 1688 engine is migrated source from `superjack2050/1688-cli`.
- Keep collection only: login, logout, whoami, doctor, profile, keyword search, image search, offers, similar, debug.
- `source keyword` must deep collect offer details by default.
- `offer` is renamed to `offers`; keep one shape for single and multiple IDs.
- Image search should return candidates; detail collection must reuse `offers`.
- Similar search must use the official similar entry only and must not fall back to keyword or image search.

## Forbidden scope

Do not add cart, checkout, order, seller chat, supplier research, research, compare, feedback, automatic purchasing, daemon, or background process behavior.

## Safety

Do not bypass 1688 risk control, sliders, or captchas. Do not use captcha-solving services. Do not log cookies, tokens, account secrets, or hard-coded credentials.

## Repository skills

- For Ozon category selection and SKU category grouping, read
  `packages/steps/category-decision/SKILL.md`.
- For factual Ozon attribute mapping, read
  `packages/steps/attribute-mapping/SKILL.md`.
- For Russian copy and validated Ozon draft generation, read
  `packages/steps/draft-generation/SKILL.md`.
- Keep skills in their owning packages. Resolve product artifacts through
  `data/runs/<run_id>/manifest.json`; legacy product workspaces remain available
  for CLI compatibility. Do not copy skill files into run or product workspaces.
