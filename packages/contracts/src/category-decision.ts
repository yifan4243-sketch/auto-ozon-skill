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
