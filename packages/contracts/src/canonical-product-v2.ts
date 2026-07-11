import type { CollectionMethod } from './common.js';

export type CanonicalWeightUnitV2 = 'g' | 'kg' | 'unknown';

export interface CanonicalSkuPackageV2 {
  length_cm: number | null;
  width_cm: number | null;
  height_cm: number | null;
  raw_weight: number | null;
  weight_unit: CanonicalWeightUnitV2;
  source: '1688';
  matched_by: 'sku_id' | 'exact_spec' | 'none';
}

export interface CanonicalSkuV2 {
  source_sku_id: string;
  raw_spec_text: string;
  specs: Record<string, string>;
  unparsed_spec_segments: string[];
  price_cny: number | null;
  multi_price_cny: number | null;
  image: string | null;
  package: CanonicalSkuPackageV2;
}

export interface SkuAnalysisV2 {
  has_source_skus: boolean;
  is_multi_sku: boolean;
  sku_count: number;
  common_fields: Record<string, unknown>;
  varying_fields: Array<{
    field: string;
    values_by_sku: Record<string, unknown>;
  }>;
  variant_dimensions: Array<{
    source_name: string;
    values: string[];
    distinguishes_skus: boolean;
    missing_for_skus: string[];
  }>;
  missing_fields: Array<{
    field: string;
    sku_ids: string[];
  }>;
  duplicate_spec_combinations: Array<{
    sku_ids: string[];
    specs: Record<string, string>;
  }>;
  warnings: string[];
}

export interface CanonicalProductV2 {
  schema_version: 2;
  source: {
    platform: '1688';
    offer_id: string;
    offer_url: string;
    collected_at: string;
    collection_method: CollectionMethod;
    detail_url: string | null;
    source_category_path_zh: string[];
    discovery_context: {
      search_term: string | null;
      seed_offer_id: string | null;
    };
  };
  product: {
    title_zh: string;
    main_image: string | null;
    gallery_images: string[];
    attributes: Record<string, string>;
    price_tiers: Array<{
      min_qty: number;
      price_cny: number;
    }>;
    sku_options: Array<{
      source_name: string;
      values: Array<{
        value: string;
        image_url: string | null;
      }>;
    }>;
  };
  skus: CanonicalSkuV2[];
  sku_analysis: SkuAnalysisV2;
  validation: {
    status: 'valid' | 'warning' | 'needs_review' | 'blocked';
    warnings: string[];
    errors: string[];
  };
}
