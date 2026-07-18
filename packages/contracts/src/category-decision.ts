export type CategoryDecisionStatusV1 = 'decided' | 'needs_review' | 'blocked';

export type ProductStructureV1 =
  | 'single_sku'
  | 'normal_variants'
  | 'mixed_product'
  | 'unclear';

export type CategoryDecisionConfidenceV1 = 'high' | 'medium' | 'low';

export interface CategoryDecisionEvidenceV1 {
  source:
    | 'search_term'
    | 'title_zh'
    | 'source_category_path_zh'
    | 'attribute'
    | 'sku_spec';
  value: string;
}

export interface OzonCategorySelectionV1 {
  description_category_id: number;
  description_category_name: string;
  type_id: number;
  type_name: string;
  category_path_zh: string[];
}

export interface CategoryDecisionIssueV1 {
  code: string;
  message: string;
  sku_ids: string[];
}

export interface CategoryGroupDecisionV1 {
  group_id: string;
  source_sku_ids: string[];
  group_summary_zh: string;
  evidence: CategoryDecisionEvidenceV1[];
  selected_category: OzonCategorySelectionV1 | null;
  alternative_categories: OzonCategorySelectionV1[];
  confidence: CategoryDecisionConfidenceV1;
  rationale_zh: string;
}

export interface CategoryDecisionV1 {
  schema_version: 1;
  category_snapshot?: {
    schema_version: 1;
    source: 'ozon-seller-api';
    captured_at: string;
    valid_from: string;
    valid_to: string;
    sha256: string;
  };
  source_offer_id: string;
  product_understanding: {
    summary_zh: string;
    product_family_zh: string;
    evidence: CategoryDecisionEvidenceV1[];
  };
  representative_sku_ids: string[];
  product_structure: ProductStructureV1;
  category_groups: CategoryGroupDecisionV1[];
  unassigned_sku_ids: string[];
  status: CategoryDecisionStatusV1;
  warnings: CategoryDecisionIssueV1[];
  errors: CategoryDecisionIssueV1[];
}

export interface CategoryDecisionAgentTaskV1 {
  schema_version: 1;
  execution_owner: 'current_agent';
  source_offer_id: string;
  category_snapshot: NonNullable<CategoryDecisionV1['category_snapshot']>;
  evidence: {
    search_term: string | null;
    title_zh: string;
    source_category_path_zh: string[];
    product_attributes: Record<string, string>;
    skus: Array<{
      source_sku_id: string;
      raw_spec_text: string;
      specs: Record<string, string>;
      image: string | null;
    }>;
  };
  initial_candidate_sets: Array<{
    query: string;
    candidates: Array<OzonCategorySelectionV1 & { score: number }>;
  }>;
  instruction: string;
}
