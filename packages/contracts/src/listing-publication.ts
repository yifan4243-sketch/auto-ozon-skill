export interface StorePublishProfileV1 {
  schema_version: 1;
  publishing: {
    enabled: boolean;
    credentials_ref: string;
  };
  pricing: {
    currency_code: 'CNY';
    markup_multiplier: number;
  };
  vat: string;
  polling: {
    interval_ms: number;
    timeout_ms: number;
    max_retries: 2;
  };
}

export interface OzonImportAttributeV1 {
  id: number;
  complex_id: number;
  values: Array<{ dictionary_value_id?: number; value: string }>;
}

export interface OzonImportItemV1 {
  offer_id: string;
  description_category_id: number;
  type_id: number;
  name: string;
  price: string;
  currency_code: 'CNY';
  vat: string;
  attributes: OzonImportAttributeV1[];
  images: string[];
  primary_image: string;
  dimension_unit?: 'cm';
  depth?: number;
  width?: number;
  height?: number;
  weight_unit?: 'g';
  weight?: number;
}

export interface ListingPayloadV1 {
  schema_version: 1;
  run_id: string;
  source_offer_id: string;
  request_sha256: string;
  swagger_sha256: string;
  sku_offer_ids: Record<string, string>;
  request: { items: OzonImportItemV1[] };
  created_at: string;
}

export interface OzonPublishErrorV1 {
  code: string;
  message: string;
  state?: string;
  level?: string;
  field?: string;
  attribute_id?: number;
  attribute_name?: string;
}

export interface OzonPublishSkuResultV1 {
  source_sku_id: string;
  offer_id: string;
  product_id: number | null;
  ozon_sku: number | null;
  product_url: string | null;
  status: 'pending' | 'imported' | 'failed' | 'skipped' | 'timed_out';
  errors: OzonPublishErrorV1[];
  retry_count: number;
}

export interface OzonPublishResultV1 {
  schema_version: 1;
  run_id: string;
  request_sha256: string;
  task_ids: number[];
  status: 'succeeded' | 'partial' | 'failed';
  submitted_at: string;
  completed_at: string;
  items: OzonPublishSkuResultV1[];
}
