import type { CanonicalSkuV2 } from '@auto-ozon/contracts';

/** CanonicalProductV2 package.raw_weight is packaging evidence, never net weight. */
export function normalizedPackagedWeightGrams(sku: CanonicalSkuV2): number | null {
  const raw = sku.package.raw_weight;
  if (raw === null || !Number.isFinite(raw) || raw <= 0) return null;
  if (sku.package.weight_unit === 'g') return decimal(raw);
  if (sku.package.weight_unit === 'kg') return decimal(raw * 1000);
  return null;
}

export function decimal(value: number): number {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}
