export interface MarketSelectionMetricsV1 {
  gmv: number | null;
  items: number | null;
  growth_percent: number | null;
  seller_count: number | null;
  buyout_percent: number | null;
  leader_share_percent: number | null;
}

export interface OpportunityScoreComponentsV1 {
  demand_gmv: number | null;
  demand_items: number | null;
  growth: number | null;
  small_seller_opportunity: number | null;
  competition_balance: number | null;
  buyout: number | null;
  long_tail: number | null;
  seasonality: number;
  /** Product-level profit is unavailable until 1688 price and package facts exist. */
  profit: null;
  /** Product-level logistics is unavailable until package facts exist. */
  logistics: null;
  /** Product-level regulatory/image risk is unavailable until a product is collected. */
  risk: null;
}

export interface SelectedMarketCategoryV1 {
  analytics_category_id: number;
  root_category_id: number;
  root_category_name_zh: string;
  category_path_zh: string;
  search_keyword_1688_zh: string;
  score: number;
  metrics: MarketSelectionMetricsV1;
  score_components: OpportunityScoreComponentsV1;
  unavailable_components: string[];
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
  status: 'succeeded' | 'skipped' | 'stopped' | 'failed';
  value: T | null;
  attempts: CollectionAttemptV1[];
  final_error_code: string | null;
}
