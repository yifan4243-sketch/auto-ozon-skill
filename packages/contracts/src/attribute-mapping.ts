export type AttributeMappingStatusV1 = 'completed' | 'needs_review' | 'blocked';
export type AttributeMappingConfidenceV1 = 'high' | 'medium' | 'low';
export type AttributeMappingProvenanceV1 =
  | 'source'
  | 'converted'
  | 'derived'
  | 'agent_selected'
  | 'default';

export interface AttributeMappingEvidenceV1 {
  source: 'canonical_v2' | 'category_attributes' | 'category_decision' | 'cost_pricing' | 'agent_input' | 'policy';
  field: string;
  value: string;
}

export interface AttributeMappingValueV1 {
  dictionary_value_id?: number;
  value: string;
}

export interface MappedOzonAttributeV1 {
  attribute_id: number;
  values: AttributeMappingValueV1[];
  provenance: AttributeMappingProvenanceV1;
  confidence: AttributeMappingConfidenceV1;
  evidence: AttributeMappingEvidenceV1[];
}

export interface OzonReadyAttributeV1 {
  id: number;
  complex_id: number;
  values: AttributeMappingValueV1[];
}

export interface CommonAttributeMappingV1 {
  group_id: string;
  attribute: MappedOzonAttributeV1;
}

export interface VariantAttributeMappingV1 {
  group_id: string;
  attribute_id: number;
  values_by_sku: Record<string, AttributeMappingValueV1[]>;
}

export interface SkuAttributeMappingV1 {
  source_sku_id: string;
  group_id: string;
  description_category_id: number;
  type_id: number;
  attributes: MappedOzonAttributeV1[];
  ozon_attributes: OzonReadyAttributeV1[];
}

export interface AttributeMappingAgentTaskV1 {
  source_sku_id: string;
  group_id: string;
  attribute_id: number;
  attribute_name: string;
  required: boolean;
  instruction: string;
  source_facts: AttributeMappingEvidenceV1[];
  dictionary_candidates: AttributeMappingValueV1[];
}

export interface MissingRequiredAttributeV1 {
  group_id: string;
  attribute_id: number;
  attribute_name: string;
  source_sku_ids: string[];
}

export interface UnresolvedAttributeV1 {
  group_id: string;
  attribute_id: number;
  attribute_name: string;
  source_sku_ids: string[];
  reason:
    | 'no_source_match'
    | 'dictionary_value_not_found'
    | 'invalid_agent_value'
    | 'low_confidence'
    | 'unsupported_type';
}

export interface AttributeMappingIssueV1 {
  code: string;
  message: string;
  sku_ids: string[];
  attribute_ids: number[];
}

export interface AttributeMappingV1 {
  schema_version: 1;
  source_offer_id: string;
  status: AttributeMappingStatusV1;
  common_attributes: CommonAttributeMappingV1[];
  variant_attributes: VariantAttributeMappingV1[];
  sku_attributes: SkuAttributeMappingV1[];
  agent_tasks: AttributeMappingAgentTaskV1[];
  missing_required_attributes: MissingRequiredAttributeV1[];
  unresolved_attributes: UnresolvedAttributeV1[];
  warnings: AttributeMappingIssueV1[];
  errors: AttributeMappingIssueV1[];
}

export interface AttributeMappingAgentAttributeV1 {
  attribute_id: number;
  values: AttributeMappingValueV1[];
  confidence: AttributeMappingConfidenceV1;
  evidence: AttributeMappingEvidenceV1[];
}

export interface AttributeMappingAgentSkuInputV1 {
  source_sku_id: string;
  attributes: AttributeMappingAgentAttributeV1[];
}

export interface AttributeMappingAgentInputV1 {
  source_offer_id: string;
  sku_inputs: AttributeMappingAgentSkuInputV1[];
}
