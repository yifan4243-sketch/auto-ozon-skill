import type {
  CanonicalSkuPackageV2,
  CanonicalSkuV2,
  CanonicalWeightUnitV2,
} from '../../contracts/src/canonical-product-v2.js';
import {
  normalizeSpecForMatch,
  parseSkuSpec,
  type SourceSkuOption,
} from './sku-spec-parser.js';
import {
  normalizePositivePackageValue,
  normalizeRawWeight,
} from './package-value-normalizer.js';

export interface SourceSkuForAssembly {
  skuId: string;
  specs: string;
  price: number | null;
  multiPrice: number | null;
  stock: number | null;
  saleCount: number | null;
  image: string | null;
  structuredSpecs?: Record<string, string> | null;
}

export interface SourcePackageForAssembly {
  skuId: string;
  spec: string;
  length: number | null;
  width: number | null;
  height: number | null;
  weight: number | null;
  volume: number | null;
  weightUnit?: string | null;
}

export interface SkuAssemblyInput {
  skus: SourceSkuForAssembly[];
  packageInfo: SourcePackageForAssembly[];
  options: SourceSkuOption[];
  priceMin: number | null;
  priceTiers?: Array<{ minQty: number; price: number }>;
  mainImage: string | null;
}

export function assembleCanonicalSkus(input: SkuAssemblyInput): CanonicalSkuV2[] {
  if (input.skus.length === 0) return [assembleDefaultSku(input)];

  return input.skus.map((sourceSku) => {
    const parsed = parseSkuSpec({
      raw_spec_text: sourceSku.specs,
      options: input.options,
      structured_specs: sourceSku.structuredSpecs,
    });
    const sourcePackage = matchPackage(sourceSku, input.packageInfo);
    return {
      source_sku_id: String(sourceSku.skuId ?? '').trim(),
      raw_spec_text: sourceSku.specs,
      specs: parsed.specs,
      unparsed_spec_segments: parsed.unparsed_spec_segments,
      price_cny: finiteOrNull(sourceSku.price),
      multi_price_cny: finiteOrNull(sourceSku.multiPrice),
      supplier_stock: finiteOrNull(sourceSku.stock),
      sale_count: finiteOrNull(sourceSku.saleCount),
      image: sourceSku.image || null,
      package: sourcePackage
        ? toCanonicalPackage(sourcePackage.item, sourcePackage.matchedBy)
        : emptyPackage(),
    };
  });
}

function assembleDefaultSku(input: SkuAssemblyInput): CanonicalSkuV2 {
  const uniquePackage = input.packageInfo.length === 1 ? input.packageInfo[0]! : null;
  return {
    source_sku_id: 'DEFAULT',
    raw_spec_text: '',
    specs: {},
    unparsed_spec_segments: [],
    price_cny: determineDefaultPrice(input),
    multi_price_cny: null,
    supplier_stock: null,
    sale_count: null,
    image: input.mainImage,
    package: uniquePackage ? toCanonicalPackage(uniquePackage, 'none') : emptyPackage(),
  };
}

function matchPackage(
  sku: SourceSkuForAssembly,
  packages: SourcePackageForAssembly[],
): { item: SourcePackageForAssembly; matchedBy: 'sku_id' | 'exact_spec' } | null {
  const sourceSkuId = String(sku.skuId).trim();
  if (sourceSkuId) {
    const bySkuId = packages.find(
      (item) => String(item.skuId).trim() === sourceSkuId,
    );
    if (bySkuId) return { item: bySkuId, matchedBy: 'sku_id' };
  }

  const normalizedSpec = normalizeSpecForMatch(sku.specs);
  if (!normalizedSpec) return null;
  const exactMatches = packages.filter(
    (item) => normalizeSpecForMatch(item.spec) === normalizedSpec,
  );
  if (exactMatches.length === 1) {
    return { item: exactMatches[0]!, matchedBy: 'exact_spec' };
  }
  return null;
}

function toCanonicalPackage(
  input: SourcePackageForAssembly,
  matchedBy: CanonicalSkuPackageV2['matched_by'],
): CanonicalSkuPackageV2 {
  const rawWeight = normalizeRawWeight(input.weight);
  return {
    length_cm: normalizePositivePackageValue(input.length),
    width_cm: normalizePositivePackageValue(input.width),
    height_cm: normalizePositivePackageValue(input.height),
    raw_weight: rawWeight,
    weight_unit: rawWeight === null ? 'unknown' : normalizeWeightUnit(input.weightUnit),
    volume_cm3: normalizePositivePackageValue(input.volume),
    source: '1688',
    matched_by: matchedBy,
  };
}

function emptyPackage(): CanonicalSkuPackageV2 {
  return {
    length_cm: null,
    width_cm: null,
    height_cm: null,
    raw_weight: null,
    weight_unit: 'unknown',
    volume_cm3: null,
    source: '1688',
    matched_by: 'none',
  };
}

function normalizeWeightUnit(value: string | null | undefined): CanonicalWeightUnitV2 {
  const unit = value?.trim().toLocaleLowerCase();
  if (unit === 'g' || unit === '克' || unit === 'gram' || unit === 'grams') return 'g';
  if (unit === 'kg' || unit === '千克' || unit === '公斤' || unit === 'kilogram') return 'kg';
  return 'unknown';
}

function determineDefaultPrice(input: SkuAssemblyInput): number | null {
  const direct = finiteOrNull(input.priceMin);
  if (direct !== null) return direct;
  const tierPrices = (input.priceTiers ?? [])
    .map((tier) => finiteOrNull(tier.price))
    .filter((price): price is number => price !== null);
  return tierPrices.length > 0 ? Math.min(...tierPrices) : null;
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
