# Local configuration formats

Use these as the shapes for Git-ignored local files. Do not put a real API key
in an example or committed file.

## `data/config/ozon-stores.local.json`

```json
[
  {
    "store_id": "123456",
    "store_name": "测试店铺",
    "publishing": { "enabled": false },
    "credentials": {
      "client_id_env": "OZON_CLIENT_ID_123456",
      "api_key_env": "OZON_API_KEY_123456"
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
    "formula_text": "到俄固定成本 × 2",
    "cost_pricing_profile": {
      "transport": "land",
      "sales_unit_quantity": 1,
      "pricing_multiplier": 2,
      "retained_target_percent": 20,
      "label_fee_cny": 2,
      "domestic_shipping_cny": 0,
      "other_fixed_cny": 0,
      "other_rate_percent": 10
    }
  }
}
```

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
  "base_url": "https://your-image-provider.example/v1",
  "model": "your-image-model",
  "api_key_env": "IMAGE_GENERATION_API_KEY",
  "use_1688_reference_images": true,
  "image_count": 3,
  "prompt_version": "product-image-v1"
}
```
