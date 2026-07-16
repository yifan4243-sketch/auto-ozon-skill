import type { ListingDraftItemV1 } from './listing-draft.js';

export interface StorePublishProfileV1 {
  store_id: string;
  publishing: { enabled: boolean };
  credentials: { client_id_env: string; api_key_env: string };
  polling: { timeout_ms: number; interval_ms: number; max_recoverable_retries: 2 };
}

export type OzonSkuPublishStatusV1 = 'pending' | 'imported' | 'failed' | 'skipped';
export interface OzonSkuPublishResultV1 {
  offer_id: string;
  request_hash: string;
  status: OzonSkuPublishStatusV1;
  product_id: number | null;
  errors: string[];
  retry_count: number;
}

export type OzonPublishStatusV1 = 'completed' | 'partial_failed' | 'polling_timeout' | 'blocked' | 'failed';
export interface OzonPublishResultV1 {
  schema_version: 1;
  store_id: string;
  source_offer_id: string;
  draft_sha256: string;
  status: OzonPublishStatusV1;
  task_ids: string[];
  /** Maps an Ozon import task to exactly the offer_ids submitted in that task. */
  task_items: Record<string, string[]>;
  submitted_at: string | null;
  completed_at: string | null;
  sku_results: OzonSkuPublishResultV1[];
  warnings: string[];
  errors: string[];
}

export interface SellerImportInfoV1 {
  complete: boolean;
  items: Array<{ offer_id: string; status: 'imported' | 'failed' | 'pending'; errors?: string[]; recoverable?: boolean }>;
}

export interface SellerImportTransportV1 {
  submit(items: ListingDraftItemV1[]): Promise<{ task_id: string }>;
  getImportInfo(taskId: string): Promise<SellerImportInfoV1>;
  getProductsByOfferIds(offerIds: string[]): Promise<Array<{ offer_id: string; product_id: number }>>;
}
