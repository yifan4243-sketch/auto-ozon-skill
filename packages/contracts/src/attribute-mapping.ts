export type AttributeMappingStatusV1 = 'completed' | 'needs_review' | 'blocked';
export type AttributeMappingConfidenceV1 = 'high' | 'medium' | 'low';
export type AttributeMappingProvenanceV1 =
  | 'source'
  | 'converted'
  | 'derived'
  | 'agent_selected'
  | 'default';

export interface AttributeMappingEvidenceV1 {
  source: 'canonical_v2' | 'category_attributes' | 'category_decision' | 'agent_input' | 'policy';
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
  reason: 'no_source_match' | 'dictionary_value_not_found' | 'low_confidence' | 'unsupported_type';
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

export interface AttributeMappingEvidenceV2 {
  source: AttributeMappingEvidenceV1['source'];
  source_path: string;
  source_value: unknown;
  normalized_value: string;
}

export interface MappedOzonAttributeV2 extends Omit<MappedOzonAttributeV1, 'evidence'> {
  evidence: AttributeMappingEvidenceV2[];
}

export interface AttributeMappingSnapshotRefV2 {
  group_id: string;
  description_category_id: number;
  type_id: number;
  fetched_at: string;
  sha256: string;
}

export interface AttributeMappingV2 {
  schema_version: 2;
  source_offer_id: string;
  status: AttributeMappingStatusV1;
  snapshot_refs: AttributeMappingSnapshotRefV2[];
  common_attributes: Array<{ group_id: string; attribute: MappedOzonAttributeV2 }>;
  variant_attributes: VariantAttributeMappingV1[];
  sku_attributes: Array<Omit<SkuAttributeMappingV1, 'attributes'> & { attributes: MappedOzonAttributeV2[] }>;
  missing_required_attributes: MissingRequiredAttributeV1[];
  unresolved_attributes: UnresolvedAttributeV1[];
  warnings: AttributeMappingIssueV1[];
  errors: AttributeMappingIssueV1[];
}
