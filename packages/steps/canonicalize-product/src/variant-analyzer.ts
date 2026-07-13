import type {
  CanonicalSkuV2,
  SkuAnalysisV2,
} from '@auto-ozon/contracts';
import { compareSkuFields } from './sku-field-comparator.js';

export function analyzeSkuVariants(input: {
  skus: CanonicalSkuV2[];
  hasSourceSkus: boolean;
  sourceDimensionNames?: string[];
}): SkuAnalysisV2 {
  const sourceDimensionNames = input.sourceDimensionNames ?? [];
  const comparison = compareSkuFields(input.skus, sourceDimensionNames);
  const variantDimensions = buildVariantDimensions(input.skus, sourceDimensionNames);
  const duplicateSpecs = findDuplicateSpecCombinations(input.skus);
  const warnings: string[] = [];

  const missingPackages = input.skus
    .filter(packageHasNoFacts)
    .map((sku) => sku.source_sku_id);
  if (missingPackages.length > 0) {
    warnings.push(`Missing package data for SKU(s): ${missingPackages.join(', ')}.`);
  }
  const missingRawWeights = input.skus
    .filter((sku) => sku.package.raw_weight === null)
    .map((sku) => sku.source_sku_id);
  if (missingRawWeights.length > 0) {
    warnings.push(
      `Missing valid package raw weight for SKU(s): ${missingRawWeights.join(', ')}.`,
    );
  }
  const unparsed = input.skus
    .filter((sku) => sku.unparsed_spec_segments.length > 0)
    .map((sku) => sku.source_sku_id);
  if (unparsed.length > 0) {
    warnings.push(`Unparsed specification segments for SKU(s): ${unparsed.join(', ')}.`);
  }
  if (duplicateSpecs.length > 0) {
    warnings.push('Duplicate SKU specification combinations require review.');
  }

  return {
    has_source_skus: input.hasSourceSkus,
    is_multi_sku: input.hasSourceSkus && input.skus.length > 1,
    sku_count: input.skus.length,
    common_fields: comparison.common_fields,
    varying_fields: comparison.varying_fields,
    variant_dimensions: variantDimensions,
    missing_fields: comparison.missing_fields,
    duplicate_spec_combinations: duplicateSpecs,
    warnings,
  };
}

function buildVariantDimensions(
  skus: CanonicalSkuV2[],
  sourceNames: string[],
): SkuAnalysisV2['variant_dimensions'] {
  const dimensions: string[] = [];
  const seen = new Set<string>();
  for (const name of sourceNames) add(name);
  for (const sku of skus) {
    for (const name of Object.keys(sku.specs)) add(name);
  }

  return dimensions.map((sourceName) => {
    const values: string[] = [];
    const seenValues = new Set<string>();
    const missingForSkus: string[] = [];
    for (const sku of skus) {
      const value = sku.specs[sourceName];
      if (!value) {
        missingForSkus.push(sku.source_sku_id);
      } else if (!seenValues.has(value)) {
        seenValues.add(value);
        values.push(value);
      }
    }
    return {
      source_name: sourceName,
      values,
      distinguishes_skus: values.length > 1,
      missing_for_skus: missingForSkus,
    };
  });

  function add(name: string): void {
    if (!name || seen.has(name)) return;
    seen.add(name);
    dimensions.push(name);
  }
}

function findDuplicateSpecCombinations(
  skus: CanonicalSkuV2[],
): SkuAnalysisV2['duplicate_spec_combinations'] {
  const groups = new Map<string, { skuIds: string[]; specs: Record<string, string> }>();
  for (const sku of skus) {
    const orderedSpecs = Object.fromEntries(
      Object.entries(sku.specs).sort(([left], [right]) => left.localeCompare(right)),
    );
    const key = JSON.stringify(orderedSpecs);
    const current = groups.get(key);
    if (current) current.skuIds.push(sku.source_sku_id);
    else groups.set(key, { skuIds: [sku.source_sku_id], specs: orderedSpecs });
  }
  return [...groups.values()]
    .filter((group) => group.skuIds.length > 1)
    .map((group) => ({ sku_ids: group.skuIds, specs: group.specs }));
}

function packageHasNoFacts(sku: CanonicalSkuV2): boolean {
  return sku.package.length_cm === null &&
    sku.package.width_cm === null &&
    sku.package.height_cm === null &&
    sku.package.raw_weight === null;
}
