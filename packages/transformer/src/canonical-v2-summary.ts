import type { CanonicalProductV2 } from '../../contracts/src/canonical-product-v2.js';
import type { CanonicalV2RunSummary } from '../../contracts/src/sourcing-result-v2.js';

export function summarizeCanonicalV2Run(
  products: CanonicalProductV2[],
): CanonicalV2RunSummary {
  const summary: CanonicalV2RunSummary = {
    product_count: products.length,
    total_sku_count: 0,
    validation_status_counts: {
      valid: 0,
      warning: 0,
      needs_review: 0,
      blocked: 0,
    },
    package_match_counts: {
      sku_id: 0,
      exact_spec: 0,
      none: 0,
    },
    missing_package_sku_count: 0,
    missing_weight_sku_count: 0,
    unparsed_spec_sku_count: 0,
    duplicate_spec_group_count: 0,
  };

  for (const product of products) {
    summary.validation_status_counts[product.validation.status] += 1;
    summary.total_sku_count += product.skus.length;
    summary.duplicate_spec_group_count +=
      product.sku_analysis.duplicate_spec_combinations.length;
    for (const sku of product.skus) {
      summary.package_match_counts[sku.package.matched_by] += 1;
      if (!hasPackageFacts(sku.package)) summary.missing_package_sku_count += 1;
      if (sku.package.raw_weight === null) summary.missing_weight_sku_count += 1;
      if (sku.unparsed_spec_segments.length > 0) {
        summary.unparsed_spec_sku_count += 1;
      }
    }
  }

  return summary;
}

function hasPackageFacts(pkg: CanonicalProductV2['skus'][number]['package']): boolean {
  return pkg.length_cm !== null ||
    pkg.width_cm !== null ||
    pkg.height_cm !== null ||
    pkg.raw_weight !== null ||
    pkg.volume_cm3 !== null;
}
