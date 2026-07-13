import type { CanonicalProductV2 } from './canonical-product-v2.js';
import type { CollectionMethod } from './common.js';

export interface CanonicalV2RunSummary {
  product_count: number;
  total_sku_count: number;
  validation_status_counts: {
    valid: number;
    warning: number;
    needs_review: number;
    blocked: number;
  };
  package_match_counts: {
    sku_id: number;
    exact_spec: number;
    none: number;
  };
  missing_package_sku_count: number;
  missing_weight_sku_count: number;
  unparsed_spec_sku_count: number;
  duplicate_spec_group_count: number;
}

export interface CanonicalV2IntegrityViolation {
  code: string;
  offer_id: string | null;
  source_sku_id: string | null;
  message: string;
}

export interface CanonicalV2IntegrityProductResult {
  offer_id: string;
  source_sku_count: number;
  expected_canonical_sku_count: number;
  canonical_sku_count: number;
  passed: boolean;
  violation_codes: string[];
}

export interface CanonicalV2IntegrityReport {
  status: 'pass' | 'fail';
  checked_product_count: number;
  violations: CanonicalV2IntegrityViolation[];
  product_results: CanonicalV2IntegrityProductResult[];
}

export interface CanonicalV2ProductArtifactPaths {
  manifest: string;
  source_1688: string;
  canonical_v2: string;
  integrity_report: string;
}

export interface CanonicalV2ProductArtifacts {
  offer_id: string;
  product_directory: string;
  artifact_paths: CanonicalV2ProductArtifactPaths;
}

export interface CanonicalV2FailureArtifacts {
  offer_id: string;
  product_directory: string;
  manifest: string;
  source_failure: string;
}

export interface CanonicalV2RunArtifacts {
  products_root: string;
  products: CanonicalV2ProductArtifacts[];
  failures: CanonicalV2FailureArtifacts[];
}

export interface SourcingResultV2 {
  schema_version: 2;
  mode: CollectionMethod;
  query: string | null;
  offer_ids: string[];
  total: number;
  success: number;
  failed: number;
  items: CanonicalProductV2[];
  failures: Array<{
    offer_id: string | null;
    code: string;
    message: string;
    recoverable: boolean;
  }>;
  summary: CanonicalV2RunSummary;
  integrity_report: CanonicalV2IntegrityReport;
  artifacts: CanonicalV2RunArtifacts | null;
  raw?: unknown;
}
