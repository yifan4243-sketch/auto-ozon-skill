---
name: ozon-customer-setup
description: Configure a customer's local auto-ozon-skill store, collection limits, pricing preferences, retry policy, and publishing permission. Use when a customer asks to configure the project, bind an Ozon store, change SKU or price limits, change pricing defaults, inspect local configuration, or enable or disable automatic publishing.
---

# Customer setup

Configure only local, Git-ignored files. Never change workflow rules under
`packages/steps`, commit credentials, print secrets, or write secrets into a
run artifact.

After configuration, route customer listing requests through the repository
root `SKILL.md` (`ozon-workflow-router`). This Skill configures preferences; it
does not decide whether a later request needs market selection or a supplied
1688 keyword.

## First use

1. Inspect `.env`, `data/config/ozon-stores.local.json`, and
   `data/config/customer-settings.local.json` if they exist. Report only whether
   a secret is configured; never display it.
2. Ask only for information that is missing or that the customer asked to
   change. Ask in this order, keeping each question short:
   - “请按当下格式给我提供店铺信息，我帮您绑定店铺：\n备注\nID\nAPI KEY”
   - “由于 1688 有部分商品有很多个 SKU，而且 Ozon 平台每个 SKU 都算一个商品额度，我建议设置最大 SKU 数量，舍弃那些 SKU 数过多的商品。请告诉我最大 SKU 数量。”
   - “采集采购价区间是多少？请按 CNY 提供最低价和最高价；不限制可回答‘不限制’。”
   - “售价和成本的计算公式是什么？例如：到俄固定成本 × 2。”
   Ask only after these answers are confirmed whether automatic publishing
   should be enabled. Default: `false`. Keep the existing account retry policy
   and per-step timeout unless the customer explicitly asks to change them.

   Ask the following question **only** when the customer explicitly asks to
   generate product images or configure image generation:
   - “请提供生图模型配置：\n\n接口地址 Base URL\n模型名称\nAPI KEY\n是否使用 1688 原图作为参考图（默认：是）\n\n如果您没有生图模型 API Key，可联系作者微信：ziyi_ozon，请备注来意。”

   Never ask for an LLM API Key, LLM Base URL, LLM model name, or a key for
   Russian copy. Russian copy and semantic attribute decisions are performed
   by the current Agent itself, then validated by repository rules.
3. Recap the proposed values, including the warning that enabling publishing
   permits `workflow listing publish` without a per-batch confirmation. Obtain
   one explicit confirmation before writing files.

## Write targets

Write atomically and preserve unrelated entries.

| File | Allowed contents |
| --- | --- |
| `.env` | `OZON_CLIENT_ID_<store>`, `OZON_API_KEY_<store>`, and, only when image generation is configured, `IMAGE_GENERATION_API_KEY`; never show a key after writing. |
| `data/config/ozon-stores.local.json` | Store metadata, env-variable references, publishing flag, polling settings. |
| `data/config/customer-settings.local.json` | Non-secret collection, pricing, retry, and timeout preferences. |
| `data/config/image-generation.local.json` | Non-secret image-model endpoint, model, reference-image policy, and image count. |

Use the templates in [references/local-config.md](references/local-config.md).
Keep `max_recoverable_retries` fixed at `2`; it is an Ozon import safety rule,
not a customer-tunable collection retry value.

## Exact field mapping

Do not rely on fixed line numbers: local JSON grows as stores are added. Locate
and update the following JSON paths instead.

| Customer answer | File and JSON path to update |
| --- | --- |
| 备注 | `data/config/ozon-stores.local.json` → matching store entry → `store_name` |
| ID | same store entry → `store_id`; `.env` → `OZON_CLIENT_ID_<store_id>`; same entry → `credentials.client_id_env` |
| API KEY | `.env` → `OZON_API_KEY_<store_id>`; same store entry → `credentials.api_key_env`; never put the key in JSON |
| 最大 SKU 数量 | `data/config/customer-settings.local.json` → `collection.max_sku_per_product` |
| 最低/最高采购价 | same file → `collection.purchase_price_cny.min` and `.max`; use `null` for “不限制” |
| 售价和成本公式 | same file → `pricing.formula_text` and `pricing.cost_pricing_profile` |
| 生图 Base URL 和模型名称 | `data/config/image-generation.local.json` → `base_url` and `model` |
| 生图 API KEY | `.env` → `IMAGE_GENERATION_API_KEY`; image config → `api_key_env` only |
| 是否使用 1688 原图 | image config → `use_1688_reference_images`; omitted answer means `true` |
| 自动发布确认 | `data/config/ozon-stores.local.json` → matching store entry → `publishing.enabled` |

Convert a formula to `pricing.cost_pricing_profile` only when it can be
expressed by the existing `CostPricingProfileV1` fields: `transport`,
`sales_unit_quantity`, `pricing_multiplier`, `retained_target_percent`,
`label_fee_cny`, `domestic_shipping_cny`, `other_fixed_cny`, and
`other_rate_percent`. For “到俄固定成本 × 2”, write `pricing_multiplier: 2`
and preserve the remaining current/default profile fields. If the formula
cannot be represented by those fields, keep it as `formula_text`, explain that
it is not executable yet, and ask the customer for an equivalent supported
formula rather than changing pricing code.

## Apply configuration

After saving, validate JSON and confirm that all secret values are absent from
the output. Then state the effective command parameters without running a
write operation:

```text
workflow listing prepare <keyword> --sku-max <max_sku>
workflow listing publish --run-id <run_id> --store-id <Client-Id>
```

When launching a workflow for the customer, translate saved collection and
pricing preferences into the existing CLI options (`--sku-max`, `--price-min`,
`--price-max`, and `--pricing-profile-json`). Do not silently enable publishing
when the local store profile says it is disabled.

For image generation, default `image_count` to `3`. Store only configuration;
do not call a model during setup. Use the versioned prompt in
[references/image-prompt.md](references/image-prompt.md) when the later
image-generation workflow is implemented.

## Later changes

- For “change SKU limit”, “change price range”, or “change multiplier”, ask
  only for the requested value and update `customer-settings.local.json`.
- For “bind another store”, add a new store entry and unique environment-variable
  names; do not overwrite an existing store.
- For “disable publishing”, set `publishing.enabled` to `false` immediately;
  retain the key locally unless the customer explicitly asks to remove it.
- For “show configuration”, redact all values whose key contains `KEY`,
  `TOKEN`, `SECRET`, `COOKIE`, or `PASSWORD`.

## Safety checks

Block and explain the issue if a Client-Id is empty, the SKU limit is not a
positive integer, a price minimum exceeds its maximum, a multiplier is not
positive, or a store is enabled without an API-key reference. Do not call
Ozon, collect 1688 data, or publish anything while configuring.
