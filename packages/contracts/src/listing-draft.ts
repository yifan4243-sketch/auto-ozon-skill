import type { OzonReadyAttributeV1 } from './attribute-mapping.js';
import type { WeightFactsV1 } from './weight-facts.js';

export type ListingDraftStatusV1 = 'draft_complete' | 'needs_review' | 'blocked';

/**
 * The publishing contract currently accepts CNY only.  Keeping this profile
 * makes a future store-level currency migration explicit rather than hidden.
 */
export interface DraftGenerationProfileV1 {
  currency_code?: 'CNY';
}

export interface ListingDraftItemV1 {
  offer_id: string;
  name: string;
  price: string;
  description_category_id: number;
  type_id: number;
  weight: number;
  depth: number;
  width: number;
  height: number;
  dimension_unit: 'mm';
  weight_unit: 'g';
  images: string[];
  primary_image: string;
  /** Attribute 4191 remains here; do not create a second top-level description. */
  attributes: OzonReadyAttributeV1[];
  complex_attributes: [];
  currency_code: 'CNY';
  vat?: string;
  barcode?: string;
  old_price?: string;
}

export interface ListingDraftIssueV1 {
  code: string;
  message: string;
  sku_ids: string[];
  attribute_ids: number[];
}

export interface ListingDraftV1 {
  schema_version: 1;
  source_offer_id: string;
  status: ListingDraftStatusV1;
  weight_semantics: WeightFactsV1['semantics'];
  image_bundle_sha256: string | null;
  items: ListingDraftItemV1[];
  warnings: ListingDraftIssueV1[];
  errors: ListingDraftIssueV1[];
}

export type ListingDraftItemV2 = ListingDraftItemV1;

export interface ListingDraftArtifactHashesV2 {
  canonical_product_sha256: string;
  category_decision_sha256: string;
  cost_pricing_sha256: string;
  category_attributes_sha256: string;
  attribute_mapping_sha256: string;
  content_bundle_sha256: string;
  image_bundle_sha256: string;
}

export interface ListingDraftCategorySnapshotV2 {
  schema_version: 1;
  source: 'ozon-seller-api';
  captured_at: string;
  valid_from: string;
  valid_to: string;
  sha256: string;
}

export interface ListingDraftAttributeSnapshotRefV2 {
  group_ids: string[];
  description_category_id: number;
  type_id: number;
  captured_at: string;
  valid_from: string;
  valid_to: string;
  sha256: string;
}

export interface ListingDraftSkuBindingV2 {
  source_sku_id: string;
  offer_id: string;
}

/**
 * Immutable, publishable draft. The item wire shape remains identical to V1;
 * V2 adds the exact upstream and Ozon snapshot bindings used by preflight.
 */
export interface ListingDraftV2 {
  schema_version: 2;
  source_offer_id: string;
  status: ListingDraftStatusV1;
  generated_at: string;
  weight_semantics: WeightFactsV1['semantics'];
  artifact_hashes: ListingDraftArtifactHashesV2;
  category_tree_snapshot: ListingDraftCategorySnapshotV2 | null;
  attribute_snapshot_refs: ListingDraftAttributeSnapshotRefV2[];
  sku_bindings: ListingDraftSkuBindingV2[];
  items: ListingDraftItemV2[];
  warnings: ListingDraftIssueV1[];
  errors: ListingDraftIssueV1[];
}
