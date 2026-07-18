# 本地配置格式

这些文件必须保持 Git 忽略。示例只写环境变量引用，绝不写真实密钥。

## `data/config/ozon-stores.local.json`

```json
[
  {
    "schema_version": 2,
    "store_id": "123456",
    "store_name": "测试店铺",
    "market": "RU",
    "currency_code": "CNY",
    "credentials": {
      "client_id": { "provider": "env", "key": "OZON_CLIENT_ID_123456" },
      "api_key": { "provider": "env", "key": "OZON_API_KEY_123456" }
    },
    "publishing": {
      "enabled": false,
      "automation_level": "automatic",
      "allowed_description_category_ids": [],
      "max_items_per_batch": 100,
      "daily_listing_limit": 100
    },
    "pricing": {
      "mode": "multiplier",
      "multiplier": "2",
      "minimum_margin_percent": "0",
      "advertising_reserve_percent": "0",
      "return_loss_reserve_percent": "0",
      "other_rate_percent": "10",
      "label_fee_cny": "2",
      "other_fixed_cny": "0"
    },
    "polling": {
      "timeout_ms": 100000,
      "interval_ms": 1500,
      "max_recoverable_retries": 2
    }
  }
]
```

## `data/config/customer-settings.local.json`

```json
{
  "schema_version": 1,
  "collection": {
    "max_sku_per_product": 3,
    "purchase_price_cny": { "min": null, "max": null },
    "account_retry_policy": {
      "accounts_in_order": ["account-1", "account-2"],
      "attempts_per_account": 3,
      "on_final_failure": "skip_product"
    },
    "step_timeout_ms": 100000
  },
  "pricing": {
    "formula_text": "到俄固定成本 × 2"
  }
}
```

可执行的价格字段必须同时写入匹配店铺的 `StoreProfileV2.pricing`。默认
`mode=multiplier`、`multiplier="2"`；目标利润模式使用
`mode=target_margin` 与 `target_margin_percent`。

## `.env`

```dotenv
OZON_CLIENT_ID_123456=123456
OZON_API_KEY_123456=replace-locally
IMAGE_GENERATION_API_KEY=replace-locally
```

## `data/config/image-generation.local.json`

```json
{
  "schema_version": 1,
  "provider_id": "customer-image-provider",
  "base_url": "https://your-image-provider.example/v1",
  "model": "your-image-model",
  "api_key_env": "IMAGE_GENERATION_API_KEY",
  "use_1688_reference_images": true,
  "image_count": 3,
  "prompt_version": "ozon-product-scenes-v1"
}
```

启用后，适配器向 `<base_url>/images/generations` 发送 `model`、`prompt`、
`n`、`response_format=url` 和 `reference_image_urls`。服务必须返回
`data[].url` 或 `images[]`。HTTP 只允许 localhost；远程地址必须使用 HTTPS。
