import type { WeightFactsV1 } from './weight-facts.js';

export type CostPricingStatusV1 = 'completed' | 'needs_agent' | 'blocked';
export type CostPricingTransportV1 = 'air' | 'air_land' | 'land';
export type CostPricingPackageSourceV1 = '1688' | 'agent_estimated';

export interface CostPricingProfileV1 {
  transport: CostPricingTransportV1;
  sales_unit_quantity: number;
  pricing_mode: 'multiplier' | 'target_margin';
  pricing_multiplier: number;
  retained_target_percent: number;
  label_fee_cny: number;
  domestic_shipping_cny: number;
  other_fixed_cny: number;
  other_rate_percent: number;
}

export interface CostPricingFxRateV1 {
  provider: 'cbr';
  cny_nominal: number;
  rub_value: number;
  rub_per_cny: number;
  published_at: string;
  fetched_at: string;
  source_url: string;
  response_sha256: string;
  cache_status: 'live' | 'cached';
}

export interface CostPricingPackageV1 {
  source: CostPricingPackageSourceV1;
  confidence: 'high' | 'low';
  actual_weight_g: number;
  source_weight_g: number;
  estimate_weight_buffer_percent: number;
  length_cm: number;
  width_cm: number;
  height_cm: number;
  evidence: string[];
}

export interface CostPricingCommissionTierV1 {
  category_id: number;
  price_min_rub: number;
  price_max_rub: number | null;
  rate_percent: number;
}

export interface CostPricingSkuV1 {
  source_sku_id: string;
  group_id: string;
  description_category_id: number;
  purchase_price_cny: number;
  purchase_cost_cny: number;
  package: CostPricingPackageV1;
  weight_facts: WeightFactsV1;
  volume_weight_kg: number;
  charge_weight_g: number;
  cel_group: string;
  cel_rate_per_g_cny: number;
  cel_fixed_fee_cny: number;
  cel_shipping_cny: number;
  landed_cost_cny: number;
  final_price_cny: number;
  final_price_rub: number;
  commission: CostPricingCommissionTierV1;
  commission_amount_cny: number;
  other_rate_amount_cny: number;
  estimated_profit_cny: number;
  estimated_profit_margin_percent: number;
}

export interface CostPricingAgentTaskV1 {
  execution_owner: 'current_agent';
  source_sku_id: string;
  group_id: string;
  instruction: string;
  source_facts: string[];
}

export interface CostPricingIssueV1 {
  code: string;
  message: string;
  sku_ids: string[];
}

export interface CostPricingV1 {
  schema_version: 1;
  source_offer_id: string;
  status: CostPricingStatusV1;
  profile: CostPricingProfileV1;
  tariff_version: 'CEL-2026-effective';
  commission_snapshot_sha256: string;
  fx_rate: CostPricingFxRateV1 | null;
  sku_pricing: CostPricingSkuV1[];
  agent_tasks: CostPricingAgentTaskV1[];
  warnings: CostPricingIssueV1[];
  errors: CostPricingIssueV1[];
}

export interface CostPricingAgentSkuInputV1 {
  source_sku_id: string;
  packaged_weight_g: number;
  length_cm: number;
  width_cm: number;
  height_cm: number;
  rationale: string;
  evidence: string[];
}

export interface CostPricingAgentInputV1 {
  source_offer_id: string;
  sku_inputs: CostPricingAgentSkuInputV1[];
}

export interface CostPricingCommissionSnapshotV1 {
  schema_version: 1;
  source: string;
  categories: Array<{
    category_id: number;
    category_name: string;
    tiers: Array<{
      price_min_rub: number;
      price_max_rub: number | null;
      rate_percent: number;
    }>;
  }>;
}
