import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ensureProductWorkspace,
  getProductWorkspacePaths,
} from '../../../packages/core/src/product-workspace.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe('product workspace', () => {
  it('creates only directories used by the current collection and category flow', async () => {
    const productsDir = await tempRoot();
    const paths = await ensureProductWorkspace('123456789', productsDir);

    expect(paths.productDirectory).toBe(path.join(productsDir, '123456789'));
    await expect(
      fs.readdir(paths.productDirectory).then((entries) => entries.sort()),
    ).resolves.toEqual([
      '1688_data',
      '1688_data_v2',
      'manifest.json',
      'ozon_category',
    ]);

    const manifest = JSON.parse(await fs.readFile(paths.manifest, 'utf8')) as {
      offer_id: string;
      artifact_paths: Record<string, string>;
    };
    expect(manifest.offer_id).toBe('123456789');
    expect(manifest.artifact_paths).toMatchObject({
      source_1688: '1688_data/source.json',
      canonical_v2: '1688_data_v2/product.json',
      category_decision: 'ozon_category/category-decision-v1.json',
      category_attributes: 'ozon_category/category-attributes-v1.json',
    });
  });

  it('rejects path traversal and non-numeric workspace names', () => {
    expect(() => getProductWorkspacePaths('../secret')).toThrow(
      'Invalid 1688 offer ID',
    );
    expect(() => getProductWorkspacePaths('abc')).toThrow(
      'Invalid 1688 offer ID',
    );
  });
});

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-ozon-products-'));
  roots.push(root);
  return root;
}
