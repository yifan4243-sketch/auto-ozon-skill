export interface MarketSelectionMetricsV1 {
  gmv: number;
  items: number;
  growth_percent: number;
  seller_count: number;
  buyout_percent: number;
  leader_share_percent: number;
}

export interface SelectedMarketCategoryV1 {
  analytics_category_id: number;
  root_category_id: number;
  root_category_name_zh: string;
  category_path_zh: string;
  search_keyword_1688_zh: string;
  score: number;
  metrics: MarketSelectionMetricsV1;
  seasonal_adjustment: number;
  seasonal_reason_zh: string;
  rationale_zh: string;
  planned_listings: number;
  candidate_collection_target: number;
  max_sku_per_product: number;
}

export interface MarketSelectionV1 {
  schema_version: 1;
  batch_id: string;
  snapshot: { path: string; sha256: string; captured_at: string };
  selection_date: string;
  daily_listing_limit: number;
  planned_listing_total: number;
  selected_categories: SelectedMarketCategoryV1[];
  rejected_categories: Array<{ analytics_category_id: number; reason: string }>;
}

export interface CollectionAttemptV1 {
  profile: string;
  attempt: number;
  status: 'succeeded' | 'failed';
  error_code: string | null;
}

export interface AccountFailoverResultV1<T> {
  status: 'succeeded' | 'skipped' | 'stopped';
  value: T | null;
  attempts: CollectionAttemptV1[];
  final_error_code: string | null;
}
