export const LEGACY_WEIGHT_SEMANTICS_V1 = 'legacy-cost-base-v1' as const;

/**
 * Locked compatibility semantics for the current workflow.
 * The cost-pricing package weight is the shared base. Attribute 4383 and the
 * draft request use that base; attribute 4497 uses base + 50 g.
 */
export interface WeightFactsV1 {
  semantics: typeof LEGACY_WEIGHT_SEMANTICS_V1;
  source: '1688' | 'user_provided' | 'agent_estimated';
  confidence: 'high' | 'low';
  source_weight_g: number;
  packaged_weight_g: number;
  platform_attribute_weight_g: number;
  cost_base_weight_g: number;
  attribute_4383_weight_g: number;
  attribute_4497_weight_g: number;
  draft_weight_g: number;
  packaging_increment_g: 50;
  increment_reason: string;
}
