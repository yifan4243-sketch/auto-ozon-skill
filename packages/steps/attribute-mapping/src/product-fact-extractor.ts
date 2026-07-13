import type { CanonicalProductV2, CanonicalSkuV2 } from '@auto-ozon/contracts';

export interface ProductFactV1 {
  name: string;
  value: string;
  field: string;
  scope: 'product' | 'sku';
}

export function extractProductFacts(
  product: CanonicalProductV2,
  sku: CanonicalSkuV2,
): ProductFactV1[] {
  return [
    ...Object.entries(product.product.attributes).map(([name, value]) => ({
      name,
      value,
      field: `product.attributes.${name}`,
      scope: 'product' as const,
    })),
    ...Object.entries(sku.specs).map(([name, value]) => ({
      name,
      value,
      field: `skus.${sku.source_sku_id}.specs.${name}`,
      scope: 'sku' as const,
    })),
  ].filter((fact) => fact.name.trim() && fact.value.trim());
}

export function normalizeFactText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}
