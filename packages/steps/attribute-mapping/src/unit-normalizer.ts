import type { CanonicalSkuV2 } from '@auto-ozon/contracts';

export function normalizedNetWeightGrams(sku: CanonicalSkuV2): number | null {
  const raw = sku.package.raw_weight;
  if (raw === null || !Number.isFinite(raw) || raw <= 0) return null;
  const grams = convertWeightToGrams(raw, sku.package.weight_unit);
  if (grams === null || grams <= 3) return null;
  return grams;
}

export function parseWeightTextToGrams(value: string): number | null {
  const normalized = value.normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
  const match = normalized.match(/(-?\d+(?:[.,]\d+)?)\s*(千克|公斤|kilograms?|kgs?|kg|克|grams?|g)/iu);
  if (!match) return null;
  const amount = Number(match[1]!.replace(',', '.'));
  const grams = convertWeightToGrams(amount, match[2]!);
  return grams !== null && grams > 3 ? grams : null;
}

function convertWeightToGrams(value: number, unit: string): number | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const normalized = unit.normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
  if (['g', '克', 'gram', 'grams'].includes(normalized)) return decimal(value);
  if (['kg', '千克', '公斤', 'kilogram', 'kilograms', 'kgs'].includes(normalized)) {
    return decimal(value * 1000);
  }
  return null;
}

export function decimal(value: number): number {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}
