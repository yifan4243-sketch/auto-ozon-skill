import type { CategoryAttributesV1 } from './category-attributes.js';

export type OzonDraftStatusV1 = 'completed' | 'needs_review' | 'blocked';
export type OzonDraftConfidenceV1 = 'high' | 'medium' | 'low';
export type OzonDraftProvenanceV1 =
  | 'source'
  | 'converted'
  | 'agent_estimated'
  | 'derived'
  | 'default';

export interface OzonDraftEvidenceV1 {
  source:
    | '1688_raw'
    | 'canonical_v2'
    | 'category_decision'
    | 'category_attributes'
    | 'agent_reasoning'
    | 'policy';
  field: string;
  value: string;
}

export interface OzonDraftAttributeV1 {
  id: number;
  complex_id: number;
  values: Array<{ dictionary_value_id?: number; value: string }>;
  provenance: OzonDraftProvenanceV1;
  confidence: OzonDraftConfidenceV1;
  evidence: OzonDraftEvidenceV1[];
}

export interface OzonDraftSkuV1 {
  source_sku_id: string;
  group_id: string;
  description_category_id: number;
  type_id: number;
  name: string;
  attributes: OzonDraftAttributeV1[];
}

export interface OzonDraftIssueV1 {
  code: string;
  message: string;
  sku_ids: string[];
  attribute_ids: number[];
}

export interface OzonProductDraftV1 {
  schema_version: 1;
  source_offer_id: string;
  status: OzonDraftStatusV1;
  items: OzonDraftSkuV1[];
  warnings: OzonDraftIssueV1[];
  errors: OzonDraftIssueV1[];
}

export interface OzonDraftValidationV1 {
  schema_version: 1;
  source_offer_id: string;
  status: OzonDraftStatusV1;
  valid: boolean;
  issues: Array<OzonDraftIssueV1 & { severity: 'warning' | 'error' }>;
}

export interface OzonDraftAgentValueV1<T> {
  value: T;
  confidence: OzonDraftConfidenceV1;
  evidence: OzonDraftEvidenceV1[];
}

export interface OzonDraftDictionaryValueV1 {
  dictionary_value_id: number;
  value: string;
}

export interface OzonDraftAgentSkuInputV1 {
  source_sku_id: string;
  name_ru: OzonDraftAgentValueV1<string>;
  description_ru: OzonDraftAgentValueV1<string>;
  hashtags_ru: OzonDraftAgentValueV1<string[]>;
  product_type: OzonDraftAgentValueV1<OzonDraftDictionaryValueV1>;
  estimated_weight_grams?: OzonDraftAgentValueV1<number>;
  brand?: OzonDraftAgentValueV1<OzonDraftDictionaryValueV1>;
  origin_country?: OzonDraftAgentValueV1<OzonDraftDictionaryValueV1>;
  colors?: OzonDraftAgentValueV1<OzonDraftDictionaryValueV1[]>;
  factory_package_count?: OzonDraftAgentValueV1<number>;
  unified_unit_count?: OzonDraftAgentValueV1<number>;
}

export interface OzonDraftAgentInputV1 {
  source_offer_id: string;
  sku_inputs: OzonDraftAgentSkuInputV1[];
}

export interface OzonDraftCategoryAttributesGroupV1 {
  group_ids: string[];
  attributes_schema: CategoryAttributesV1;
}
