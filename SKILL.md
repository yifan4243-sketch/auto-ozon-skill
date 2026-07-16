---
name: ozon-workflow-router
description: Operate this repository from a customer's natural-language Ozon listing request. Use when deciding whether to select Russian-market categories or use a supplied keyword, collecting 1688 products, configuring a store, preparing or publishing listings, or inspecting the bundled Ozon MCP methods and workflows.
---

# Ozon workflow router

Treat this as the repository's single customer-facing entry point. Keep product
artifacts under `data/runs/<run_id>/`; read that run's `manifest.json` before
resolving any step output. Keep batch planning artifacts separately under
`data/runs/<batch_id>/00-market-selection/`.

## Route the customer's request

| Customer wording | Route | Do not do |
| --- | --- | --- |
| “给我上架 20 个杯子”、“上架若干个 <明确品名>” | Treat the supplied noun as the 1688 keyword. Repeatedly run the normal product workflow for eligible candidate offers until the requested successful count is reached. | Do not start Russian-market category analysis. |
| “给我上架十个商品”、“给我把店铺上满”、“帮我选品” | Start Russian-market selection, create a 5–10-category queue, then collect each saved Chinese category name as a 1688 keyword. | Do not concentrate the batch in one category. |
| “绑定店铺”、“改 SKU 数量/价格/公式/生图模型” | Use `skills/customer-setup/SKILL.md` before collection or publishing. | Do not put API keys in Git, artifacts, or chat output. |
| “继续/查看某个 run”、“上架草稿” | Read the manifest and resume only the needed step. | Do not recollect or rebuild a completed draft unless its inputs changed. |
| “查店铺订单、库存、广告、分析” | Use the read-only Ozon MCP discovery and relevant curated MCP workflow. | Do not confuse MCP analytics workflows with this repository's listing workflow. |

For a generic request such as “上架 5 个商品”, the route is already known:
start Russian-market selection. Do **not** ask an extra “卖什么？” question.
For a request containing a concrete product noun, that noun is already the
keyword. Ask for a product name only when the customer did not state either a
quantity or a product/selection intent.

For a requested number `N`, count only SKUs confirmed `imported` by step 8.
Respect the saved SKU maximum and purchase-price range. A single CLI run handles
one selected 1688 product; the agent must keep a batch ledger and launch the
next eligible offer until `N` is met, a terminal failure occurs, or the source
candidate queue is exhausted. “上满” means the configured daily listing quota,
defaulting to 100 only if the customer has not provided a lower store limit.

## Ask collection settings for every task

Before **every** task that starts 1688 collection, ask these four questions,
even if the customer answered them on a previous task. Do not turn the answers
into permanent settings unless the customer expressly asks to save them.
Ask these four questions only; do not add an unrelated “问题 1：卖什么？”
when routing already determined the keyword or market-selection path.

1. “本次采集是否使用可视化浏览器？默认：否（无头浏览器）。”
2. “本次商品最多保留多少个 SKU？不限制可回答‘不限制’。”
3. “本次采购价区间是多少？请按 CNY 提供最低价和最高价；不限制可回答‘不限制’。”
4. “采集遇到验证码或滑块时，是否跳过当前商品并继续下一个？默认：是。”

Translate the confirmed answers as follows:

| Answer | Collection behavior |
| --- | --- |
| 可视化浏览器 = 是 | Add `--headed`; wait for the customer to complete any verification. |
| 可视化浏览器 = 否 / omitted | Run headless; this is the default. |
| 最大 SKU = N | Add `--sku-max N`; exclude products that exceed it. |
| 价格区间 = min/max | Add `--price-min min --price-max max`. |
| 验证码跳过 = 是 | Record `RISK_CONTROL` in the batch ledger, do not retry or bypass it, and continue with the next candidate. |
| 验证码跳过 = 否 | Stop the current task, reopen only with `--headed`, and wait for manual verification. |

Never use a captcha-solving service, cookies from another person, or an
automated bypass. A per-task setting overrides a saved collection preference.

## Agent-owned reasoning; no text-model API configuration

The current Agent is responsible for all non-deterministic reasoning in this
repository: Russian title and description, tags, category choice, packaging
estimation, dictionary selection, and market-selection analysis. Use the
Agent's own available model capability and then apply the repository validators.

Never ask a customer for an LLM Base URL, language-model name, LLM API Key,
OpenAI-compatible endpoint, or an “俄语内容生成 Key”. Do not create or require
`LLM_BASE_URL`, `LLM_MODEL`, or `LLM_API_KEY`. They are not part of this
project's customer setup.

The only separate model configuration is for **image generation**, and ask for
it only when the customer explicitly requests generated product images or asks
to configure image generation. It is not required for normal collection,
Russian copy, attribute mapping, draft generation, or listing submission.

Ask for Ozon store credentials only when no enabled local store profile exists
and the task has reached a real publish action. Never ask for them merely to
prepare, collect, categorize, price, or draft products.

## Our listing workflow

Run the following eight steps in order for every selected 1688 offer:

1. `source-1688` — search and deeply collect the offer.
2. `canonicalize-product` — normalize facts and SKUs.
3. `category-decision` — choose and validate Ozon category/type and group SKUs.
4. `cost-pricing` — calculate CEL cost, exchange rate, commission, and price.
5. `category-attributes` — fetch Ozon category attribute and dictionary snapshots.
6. `attribute-mapping` — apply script rules, then validated Agent values.
7. `draft-generation` — combine price, images, and attributes into import `items[]`.
8. `listing-submit` — submit the unchanged `items[]`, poll, and store per-SKU results.

Read the owning procedure before performing a specialized step:

- Market selection: `skills/ozon-russia-market-selection/SKILL.md`.
- Category decision and SKU grouping: `packages/steps/category-decision/SKILL.md`.
- Attribute mapping: `packages/steps/attribute-mapping/SKILL.md`.
- Cost pricing: `packages/steps/cost-pricing/SKILL.md`.
- Draft construction: `packages/steps/draft-generation/SKILL.md`.
- First-time and later customer configuration: `skills/customer-setup/SKILL.md`.

Use the CLI from the repository root:

```powershell
# Prepare through the internal import draft; this is read-only toward Ozon.
pnpm exec tsx apps/cli/src/cli.ts workflow listing prepare "杯子" --sku-max 3

# Publish only a draft_complete run and only to an enabled local store.
pnpm exec tsx apps/cli/src/cli.ts workflow listing publish --run-id <run_id> --store-id <Client-Id>

# Resume polling/recoverable import retry, or read the saved result.
pnpm exec tsx apps/cli/src/cli.ts workflow listing resume --run-id <run_id> --store-id <Client-Id>
pnpm exec tsx apps/cli/src/cli.ts workflow listing status --run-id <run_id>
```

Pass saved collection and pricing preferences as `--sku-max`, `--price-min`,
`--price-max`, and `--pricing-profile-json` when those CLI options are available
in the active version. Never claim that a batch succeeded until step 8 records
the successful SKU results.

## Ozon MCP: 466 methods and 13 curated workflows

The MCP bridge is an API discovery and **read-only** execution tool. Its
bundled Swagger snapshot contains roughly 466 Seller/Performance methods. Do
not paste or memorize them; discover the exact current method before using it.
Read [references/ozon-mcp-bridge.md](references/ozon-mcp-bridge.md) for the
commands, 13 workflow names, and safety boundary.

The generic `ozon call` and `ozon fetch-all` commands must stay read-only.
Only `workflow listing publish` may write, through its fixed typed adapter to
the import endpoints. It requires a locally enabled store profile and never
accepts arbitrary operation IDs or URLs.
