export interface SecretRefV1 {
  provider: 'env';
  key: string;
}

export interface StoreProfileV2 {
  schema_version: 2;
  store_id: string;
  store_name: string;
  market: 'RU';
  currency_code: 'CNY' | 'RUB';
  credentials: {
    client_id: SecretRefV1;
    api_key: SecretRefV1;
  };
  /** Optional and distinct from Seller API credentials. */
  performance_credentials?: {
    client_id: SecretRefV1;
    client_secret: SecretRefV1;
  };
  publishing: {
    enabled: boolean;
    automation_level: 'automatic';
    allowed_description_category_ids: number[];
    max_items_per_batch: number;
    daily_listing_limit: number;
  };
  pricing: {
    mode: 'multiplier' | 'target_margin';
    multiplier?: string;
    target_margin_percent?: string;
    minimum_margin_percent: string;
    advertising_reserve_percent: string;
    return_loss_reserve_percent: string;
    other_rate_percent: string;
    label_fee_cny: string;
    other_fixed_cny: string;
  };
  polling: {
    timeout_ms: number;
    interval_ms: number;
    max_recoverable_retries: 2;
  };
}
