import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type {
  CostPricingCommissionSnapshotV1,
  CostPricingCommissionTierV1,
} from '@auto-ozon/contracts';

export async function loadBundledCommissionSnapshot(): Promise<{
  snapshot: CostPricingCommissionSnapshotV1;
  sha256: string;
}> {
  const text = await fs.readFile(
    new URL('../references/ozon-commission-snapshot.json', import.meta.url),
    'utf8',
  );
  return {
    snapshot: resolveCommissionSnapshot(JSON.parse(text) as unknown),
    sha256: createHash('sha256').update(text).digest('hex'),
  };
}

export function resolveCommissionSnapshot(input: unknown): CostPricingCommissionSnapshotV1 {
  if (isNormalized(input)) return input;
  const root = record(input);
  const categories: CostPricingCommissionSnapshotV1['categories'] = [];
  walk(Array.isArray(root?.data) ? root.data : [], categories);
  if (categories.length === 0) throw new Error('Commission snapshot contains no category tiers.');
  return { schema_version: 1, source: 'user-supplied-hierarchical-json', categories };
}

export function selectCommissionTier(
  snapshot: CostPricingCommissionSnapshotV1,
  categoryId: number,
  priceRub: number,
): CostPricingCommissionTierV1 | null {
  const category = snapshot.categories.find((item) => item.category_id === categoryId);
  if (!category) return null;
  const tier = category.tiers.find((item, index) => {
    const lower = index === 0 ? priceRub >= item.price_min_rub : priceRub > item.price_min_rub;
    return lower && (item.price_max_rub === null || priceRub <= item.price_max_rub);
  });
  return tier ? { category_id: categoryId, ...tier } : null;
}

function walk(nodes: unknown[], output: CostPricingCommissionSnapshotV1['categories']): void {
  for (const candidate of nodes) {
    const node = record(candidate);
    if (!node) continue;
    const children = Array.isArray(node.children) ? node.children : [];
    const categoryId = Number(node.cate_id);
    const tiers = children.flatMap(parseTier);
    if (Number.isSafeInteger(categoryId) && categoryId > 0 && tiers.length > 0) {
      output.push({ category_id: categoryId, category_name: String(node.label ?? node.value ?? ''), tiers });
    }
    walk(children, output);
  }
}

function parseTier(value: unknown, index: number): CostPricingCommissionSnapshotV1['categories'][number]['tiers'] {
  const node = record(value);
  if (!node) return [];
  const label = String(node.label ?? '');
  const encoded = String(node.value ?? '');
  const rate = Number(encoded.split(',').at(-1)?.replace('%', '').trim());
  const priceLabel = label.replace(/\([^)]*%[^)]*\)/gu, '');
  const numbers = [...priceLabel.matchAll(/\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
  if (!Number.isFinite(rate) || numbers.length === 0) return [];
  if (index === 0) return [{ price_min_rub: 0, price_max_rub: numbers.at(-1)!, rate_percent: rate }];
  if (/≤|<=/u.test(label) && numbers.length >= 2) {
    return [{ price_min_rub: numbers[0]!, price_max_rub: numbers.at(-1)!, rate_percent: rate }];
  }
  return [{ price_min_rub: numbers[0]!, price_max_rub: null, rate_percent: rate }];
}

function isNormalized(value: unknown): value is CostPricingCommissionSnapshotV1 {
  const input = record(value);
  return input?.schema_version === 1 && Array.isArray(input.categories);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
