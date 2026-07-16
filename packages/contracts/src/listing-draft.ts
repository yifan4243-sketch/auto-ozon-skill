import type { OzonReadyAttributeV1 } from './attribute-mapping.js';

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
  items: ListingDraftItemV1[];
  warnings: ListingDraftIssueV1[];
  errors: ListingDraftIssueV1[];
}
