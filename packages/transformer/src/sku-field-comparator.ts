import type {
  CanonicalSkuV2,
  SkuAnalysisV2,
} from '../../contracts/src/canonical-product-v2.js';

const BASE_COMPARISON_FIELDS = [
  'price_cny',
  'multi_price_cny',
  'image',
  'package.length_cm',
  'package.width_cm',
  'package.height_cm',
  'package.raw_weight',
  'package.weight_unit',
  'package.volume_cm3',
] as const;

export interface SkuFieldComparison {
  common_fields: SkuAnalysisV2['common_fields'];
  varying_fields: SkuAnalysisV2['varying_fields'];
  missing_fields: SkuAnalysisV2['missing_fields'];
}

export function compareSkuFields(
  skus: CanonicalSkuV2[],
  sourceDimensionNames: string[] = [],
): SkuFieldComparison {
  const specFields = collectSpecFields(skus, sourceDimensionNames).map(
    (name) => `specs.${name}`,
  );
  const fields = [...BASE_COMPARISON_FIELDS, ...specFields];
  const commonFields: Record<string, unknown> = {};
  const varyingFields: SkuAnalysisV2['varying_fields'] = [];
  const missingFields: SkuAnalysisV2['missing_fields'] = [];

  for (const field of fields) {
    const valuesBySku: Record<string, unknown> = {};
    const missingSkuIds: string[] = [];
    for (const sku of skus) {
      const value = readField(sku, field);
      valuesBySku[sku.source_sku_id] = value;
      if (isMissing(field, value)) missingSkuIds.push(sku.source_sku_id);
    }

    const values = Object.values(valuesBySku);
    const first = values[0];
    const allEqual = values.length > 0 && values.every((value) => Object.is(value, first));
    if (allEqual && !isMissing(field, first)) {
      commonFields[field] = first;
    } else if (!allEqual) {
      varyingFields.push({ field, values_by_sku: valuesBySku });
    }
    if (missingSkuIds.length > 0) {
      missingFields.push({ field, sku_ids: missingSkuIds });
    }
  }

  const packageMissing = skus
    .filter((sku) => sku.package.matched_by === 'none' && packageHasNoFacts(sku))
    .map((sku) => sku.source_sku_id);
  if (packageMissing.length > 0) {
    missingFields.unshift({ field: 'package', sku_ids: packageMissing });
  }

  return {
    common_fields: commonFields,
    varying_fields: varyingFields,
    missing_fields: missingFields,
  };
}

function collectSpecFields(skus: CanonicalSkuV2[], sourceNames: string[]): string[] {
  const seen = new Set<string>();
  const fields: string[] = [];
  for (const name of sourceNames) add(name);
  for (const sku of skus) {
    for (const name of Object.keys(sku.specs)) add(name);
  }
  return fields;

  function add(name: string): void {
    if (!name || seen.has(name)) return;
    seen.add(name);
    fields.push(name);
  }
}

function readField(sku: CanonicalSkuV2, field: string): unknown {
  if (field.startsWith('specs.')) return sku.specs[field.slice('specs.'.length)] ?? null;
  switch (field) {
    case 'price_cny':
      return sku.price_cny;
    case 'multi_price_cny':
      return sku.multi_price_cny;
    case 'image':
      return sku.image;
    case 'package.length_cm':
      return sku.package.length_cm;
    case 'package.width_cm':
      return sku.package.width_cm;
    case 'package.height_cm':
      return sku.package.height_cm;
    case 'package.raw_weight':
      return sku.package.raw_weight;
    case 'package.weight_unit':
      return sku.package.weight_unit;
    case 'package.volume_cm3':
      return sku.package.volume_cm3;
    default:
      return null;
  }
}

function isMissing(field: string, value: unknown): boolean {
  return value === null || value === undefined || value === '' ||
    (field === 'package.weight_unit' && value === 'unknown');
}

function packageHasNoFacts(sku: CanonicalSkuV2): boolean {
  return sku.package.length_cm === null &&
    sku.package.width_cm === null &&
    sku.package.height_cm === null &&
    sku.package.raw_weight === null &&
    sku.package.volume_cm3 === null;
}
