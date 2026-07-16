import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  getOzonCategoryTreeStats,
  loadOzonCategoryIndex,
  loadOzonCategoryTree,
  validateOzonCategoryPair,
} from '../../packages/steps/category-decision/src/category-tree.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const baseline = JSON.parse(fs.readFileSync(
  path.join(root, 'tests/baselines/refactor-baseline.json'),
  'utf8',
)) as {
  offer_id: string;
  artifact_sha256: Record<string, string>;
  category_tree_cli_snapshot: Record<string, number>;
  mixed_tableware_groups: Array<{
    group_id: string;
    source_sku_ids: string[];
    description_category_id: number;
    type_id: number;
    type_name: string;
  }>;
};

describe('refactor baseline equivalence', () => {
  it('keeps every real cup artifact byte-for-byte unchanged', () => {
    const productRoot = path.join(root, 'data/products', baseline.offer_id);
    const actual = Object.fromEntries(
      Object.keys(baseline.artifact_sha256).map((relative) => [
        relative,
        crypto.createHash('sha256')
          .update(fs.readFileSync(path.join(productRoot, relative)))
          .digest('hex')
          .toUpperCase(),
      ]),
    );
    expect(actual).toEqual(baseline.artifact_sha256);
  });

  it('keeps the committed Ozon category-tree CLI statistics unchanged', async () => {
    const stats = getOzonCategoryTreeStats(await loadOzonCategoryTree());
    expect(stats).toEqual(baseline.category_tree_cli_snapshot);
  });

  it('keeps the mixed tableware decision split into bowl, cup, plate, and divided plate', async () => {
    expect(baseline.mixed_tableware_groups.map((group) => group.type_name)).toEqual([
      '碗',
      '杯子',
      '盘子',
      '分餐盘',
    ]);
    expect(new Set(
      baseline.mixed_tableware_groups.flatMap((group) => group.source_sku_ids),
    ).size).toBe(4);

    const index = await loadOzonCategoryIndex();
    for (const group of baseline.mixed_tableware_groups) {
      expect(validateOzonCategoryPair(
        index,
        group.description_category_id,
        group.type_id,
      )).toMatchObject({ valid: true });
    }
  });
});
