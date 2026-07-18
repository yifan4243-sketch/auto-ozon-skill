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
   `data/config/customer-settings.local.json` if they exist. Also run `1688
   profile list`. Report only whether a secret or profile is configured; never
   display a secret, cookie, QR payload, or session value.
2. Before doing any product work, ensure that at least two independent 1688
   Profiles are logged in. If fewer than two are usable, tell the customer:

   > 为了在 1688 风控、登录失效或采集失败时能切换账号，请先登录至少两个 1688 账号。我会依次打开二维码登录；请分别扫码完成账号 1 和账号 2 的登录。

   Create distinct profile names such as `account-1` and `account-2`, unless
   the customer supplies names. Run and verify each profile in turn:

   ```text
   1688 login --profile account-1
   1688 login --profile account-2
   1688 profile status account-1
   1688 profile status account-2
   ```

   Do not collect products until two profiles are usable. Do not expose their
   cookies or attempt to bypass any login verification.
3. Bind an Ozon store if no local store is configured. Ask only for the
   following information, in this order:

   - “请按当下格式给我提供店铺信息，我帮您绑定店铺：\n备注\nID\nAPI KEY”
4. Then ask exactly one image question:

   > 是否需要为商品生成图片？默认不生成，直接使用 1688 图片。回答“需要”后我再帮您配置生图模型。

   - If the customer answers “不需要”, do not ask for any image-model field and
     do not create image-generation configuration.
   - If the customer answers “需要”, ask:

     > 请提供生图模型配置：\n\n接口地址 Base URL\n模型名称\nAPI KEY\n是否使用 1688 原图作为参考图（默认：是）\n\n如果您没有生图模型 API Key，不知道如何配置，可联系作者微信：ziyi_ozon，请备注来意。

5. Create the proposed local configuration only after the customer confirms the
   recap. Keep `publishing.enabled` as `false`; ask for a separate explicit
   confirmation only immediately before the first real Ozon publish action.

Do not ask maximum SKU count, collection price range, visual-browser mode, or
captcha policy during first-use setup. They are task-specific choices and must
be asked by the root Skill at the start of every collection task. Use the
default cost formula “到俄固定成本 × 2” unless the customer later requests a
custom formula.

Never ask for an LLM API Key, LLM Base URL, LLM model name, or a key for
Russian copy. Russian copy and semantic attribute decisions are performed by
the current Agent itself, then validated by repository rules.

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
| ID | same store entry → `store_id`; `.env` → `OZON_CLIENT_ID_<store_id>`; same entry → `credentials.client_id.key` with `provider=env` |
| API KEY | `.env` → `OZON_API_KEY_<store_id>`; same store entry → `credentials.api_key.key` with `provider=env`; never put the key in JSON |
| 最大 SKU 数量 | `data/config/customer-settings.local.json` → `collection.max_sku_per_product` |
| 最低/最高采购价 | same file → `collection.purchase_price_cny.min` and `.max`; use `null` for “不限制” |
| 售价和成本公式 | customer settings → `pricing.formula_text`; matching StoreProfileV2 → executable `pricing` fields |
| 生图 Base URL 和模型名称 | `data/config/image-generation.local.json` → `base_url` and `model` |
| 生图 API KEY | `.env` → `IMAGE_GENERATION_API_KEY`; image config → `api_key_env` only |
| 是否使用 1688 原图 | image config → `use_1688_reference_images`; omitted answer means `true` |
| 自动发布确认 | `data/config/ozon-stores.local.json` → matching store entry → `publishing.enabled` |

Convert a formula to the matching `StoreProfileV2.pricing` only when it can be
expressed as `mode=multiplier` plus `multiplier`, or `mode=target_margin` plus
`target_margin_percent`, together with the existing margin/reserve/fixed-fee
fields. For “到俄固定成本 × 2”, write `mode: multiplier` and `multiplier: "2"`
while preserving the remaining store fields. If the formula cannot be
represented, keep it as `formula_text`, explain that it is not executable yet,
and ask for an equivalent supported formula rather than changing pricing code.

## Apply configuration

After saving, validate JSON and confirm that all secret values are absent from
the output. Then state the effective command parameters without running a
write operation:

```text
workflow listing prepare <keyword> --store-id <Client-Id> --sku-max <max_sku>
workflow listing publish --run-id <run_id> --store-id <Client-Id>
```

When launching a workflow for the customer, translate saved collection and
pricing preferences into the existing CLI options (`--sku-max`, `--price-min`,
`--price-max`, and `--pricing-profile-json`). Do not silently enable publishing
when the local store profile says it is disabled.

For image generation, default `image_count` to `3`. Store only configuration;
do not call a model during setup. Use the versioned prompt in
[references/image-prompt.md](references/image-prompt.md). A later collection
uses `--generate-images`; without that flag the workflow validates and keeps
1688 originals.

## Later changes

- For “need generated product images”, ask the image question and then the
  image-model fields above. For “do not generate images”, do not request or
  modify image-model credentials.
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
