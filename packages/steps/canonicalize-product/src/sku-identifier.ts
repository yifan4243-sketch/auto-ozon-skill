import type { CanonicalSkuV2 } from '@auto-ozon/contracts';

export function validateSourceSkuIds(
  sourceSkuIds: Array<string | null | undefined>,
): string[] {
  const normalizedIds = sourceSkuIds.map(normalizeSourceSkuId);
  const errors: string[] = [];
  const emptyPositions = normalizedIds
    .map((id, index) => (id ? null : index + 1))
    .filter((position): position is number => position !== null);

  if (emptyPositions.length > 0) {
    errors.push(
      `Empty source_sku_id at source SKU position(s): ${emptyPositions.join(', ')}.`,
    );
  }

  const positionsById = new Map<string, number[]>();
  normalizedIds.forEach((id, index) => {
    if (!id) return;
    const positions = positionsById.get(id) ?? [];
    positions.push(index + 1);
    positionsById.set(id, positions);
  });
  for (const [id, positions] of positionsById) {
    if (positions.length > 1) {
      errors.push(
        `Duplicate source_sku_id "${id}" at source SKU positions: ${positions.join(', ')}.`,
      );
    }
  }

  return errors;
}

/**
 * Build collision-free keys for values_by_sku. Valid unique IDs remain
 * unchanged; empty or duplicate IDs receive deterministic positional suffixes.
 */
export function buildSkuRecordKeys(
  skus: Array<Pick<CanonicalSkuV2, 'source_sku_id'>>,
): string[] {
  const normalizedIds = skus.map((sku) => normalizeSourceSkuId(sku.source_sku_id));
  const counts = new Map<string, number>();
  for (const id of normalizedIds) counts.set(id, (counts.get(id) ?? 0) + 1);

  const used = new Set<string>();
  return normalizedIds.map((id, index) => {
    const base = id || '[empty-sku-id]';
    const preferred = id && counts.get(id) === 1 ? id : `${base}#${index + 1}`;
    let key = preferred;
    let suffix = 2;
    while (used.has(key)) {
      key = `${preferred}#${suffix}`;
      suffix += 1;
    }
    used.add(key);
    return key;
  });
}

function normalizeSourceSkuId(value: string | null | undefined): string {
  return String(value ?? '').trim();
}
