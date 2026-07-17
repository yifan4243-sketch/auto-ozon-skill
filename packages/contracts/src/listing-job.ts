export type ListingJobRouteV1 = 'keyword' | 'market_selection';
export type CaptchaPolicyV1 = 'pause' | 'skip_product';

export interface ListingJobSpecV1 {
  schema_version: 1;
  batch_id: string;
  store_id: string;
  route: ListingJobRouteV1;
  requested_listing_count: number;
  keywords: string[];
  collection: {
    profiles: [string, string, ...string[]];
    attempts_per_account: 3;
    headed: boolean;
    captcha_policy: CaptchaPolicyV1;
    max_sku_per_product: number;
    price_min_cny: number | null;
    price_max_cny: number | null;
    candidate_limit: number;
  };
  created_at: string;
}

export type BatchProductStatusV1 = 'succeeded' | 'failed' | 'skipped' | 'paused';

export interface BatchProductRunV1 {
  offer_id: string;
  keyword: string;
  run_id: string | null;
  status: BatchProductStatusV1;
  profile: string | null;
  attempts: number;
  error_code: string | null;
}

export interface ListingBatchResultV1 {
  schema_version: 1;
  batch_id: string;
  status: 'created' | 'running' | 'paused' | 'completed' | 'exhausted';
  requested_listing_count: number;
  candidate_count: number;
  succeeded_count: number;
  failed_count: number;
  skipped_count: number;
  product_runs: BatchProductRunV1[];
  created_at: string;
  updated_at: string;
}

export interface CategoryClosureV1 {
  schema_version: 1;
  analytics_category_id: number | null;
  selected_description_category_id: number;
  selected_type_id: number;
  relation: 'exact' | 'same_path_family' | 'agent_justified_deviation' | 'unrelated';
  confidence: 'high' | 'medium' | 'low';
  rationale_zh: string;
  status: 'accepted' | 'needs_review' | 'blocked';
}

export interface AgentDecisionEnvelopeV1<T> {
  schema_version: 1;
  decision_type: 'category' | 'attribute' | 'content' | 'weight_estimate';
  decision_version: string;
  input_hash: string;
  candidate_snapshot_hash: string | null;
  decided_at: string;
  decided_by: 'current_agent';
  decision: T;
}
