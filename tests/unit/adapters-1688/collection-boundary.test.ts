import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { OfferBatchResult } from '../../../packages/adapters-1688/src/engine/commands/offers.js';
import { offerToCanonical } from '../../../packages/adapters-1688/src/mappers/offer-to-canonical.js';
import { offerToCanonicalV2 } from '../../../packages/adapters-1688/src/mappers/offer-to-canonical-v2.js';
import {
  parseOfferResult,
  parseOfflineOfferInput,
} from '../../../packages/adapters-1688/src/v2/offer-result-codec.js';
import { normalizeV2Offline } from '../../../packages/adapters-1688/src/v2/offline-normalize.js';
import { collectedRunToV1 } from '../../../packages/adapters-1688/src/v2/sourcing-runtime.js';

const deprecatedKeys = new Set([
  'supplier',
  'freight',
  'categoryId',
  'source_category_id',
  'saledCount',
  'stock',
  'supplier_stock',
  'saleCount',
  'sale_count',
  'volume',
  'volume_cm3',
]);
const temporaryRoots: string[] = [];
const fixturePath = fileURLToPath(
  new URL('../../fixtures/1688/legacy-offer-result-deprecated-fields.json', import.meta.url),
);

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe('1688 retained-facts collection boundary', () => {
  it('accepts a legacy OfferResult without mutating it and rebuilds only retained facts', () => {
    const legacy = readLegacyFixture();
    const before = JSON.stringify(legacy);

    const parsed = parseOfferResult(legacy);

    expect(JSON.stringify(legacy)).toBe(before);
    expectNoDeprecatedKeys(parsed);
    expect(parsed.categoryPathZh).toEqual(['园林工具', '修剪工具', '修枝剪']);
    expect(parsed).toMatchObject({
      offerId: '987654321',
      title: '园林修枝剪 园艺工具',
      priceMin: 12.8,
      mainImage: 'https://img.example.com/pruner-main.jpg',
      skus: [
        {
          skuId: 'pruner-red-m',
          specs: '颜色:红色>尺码:M',
          price: 12.8,
          multiPrice: 10.5,
        },
      ],
      packageInfo: [{ length: 25, width: 8, height: 3, weight: 320 }],
    });
  });

  it('keeps V1 and V2 on the same reduced facts boundary', () => {
    const offer = parseOfferResult(readLegacyFixture());
    const details = batchFor(offer);
    const v1 = collectedRunToV1({
      mode: 'keyword',
      query: '修枝剪',
      imagePath: null,
      details,
    });
    const v2 = offerToCanonicalV2(
      offer,
      'keyword',
      '2026-07-11T00:00:00.000Z',
      { searchTerm: '修枝剪' },
    );

    expectNoDeprecatedKeys(v1);
    expectNoDeprecatedKeys(v2);
    expect(v1.items[0]!.source.sourceCategoryPathZh).toEqual([
      '园林工具',
      '修剪工具',
      '修枝剪',
    ]);
    expect(v2.source).toMatchObject({
      source_category_path_zh: ['园林工具', '修剪工具', '修枝剪'],
      discovery_context: { search_term: '修枝剪', seed_offer_id: null },
    });
    expect(v2.product.attributes).toMatchObject({ 材质: '高碳钢' });
    expect(v2.product.gallery_images).toContain('https://img.example.com/pruner-gallery.jpg');
    expect(v2.skus[0]).toMatchObject({
      specs: { 颜色: '红色', 尺码: 'M' },
      price_cny: 12.8,
      multi_price_cny: 10.5,
      package: {
        length_cm: 25,
        width_cm: 8,
        height_cm: 3,
        raw_weight: 320,
      },
    });
  });

  it('does not fall back to a legacy numeric category when Chinese path is absent', () => {
    const legacy = readLegacyFixture();
    delete legacy.categoryPathZh;

    const parsed = parseOfferResult(legacy);
    const v1 = offerToCanonical(parsed, 'offers');
    const v2 = offerToCanonicalV2(parsed, 'offers');

    expect(parsed.categoryPathZh).toEqual([]);
    expect(v1.source.sourceCategoryPathZh).toEqual([]);
    expect(v2.source.source_category_path_zh).toEqual([]);
    expectNoDeprecatedKeys({ parsed, v1, v2 });
  });

  it('keeps normalize-v2 output and raw artifacts free of legacy fields', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-ozon-boundary-'));
    temporaryRoots.push(root);

    const result = await normalizeV2Offline({
      inputPath: fixturePath,
      method: 'keyword',
      searchTerm: '修枝剪',
      saveDir: root,
    });

    expect(result.ok).toBe(true);
    expectNoDeprecatedKeys(result.data);
    const rawDirectory = result.data!.artifacts!.artifact_paths.raw_directory;
    const rawFiles = await fs.readdir(rawDirectory);
    expect(rawFiles).toHaveLength(1);
    const rawArtifact = JSON.parse(
      await fs.readFile(path.join(rawDirectory, rawFiles[0]!), 'utf8'),
    ) as unknown;
    expectNoDeprecatedKeys(rawArtifact);
    expect(rawArtifact).toMatchObject({
      categoryPathZh: ['园林工具', '修剪工具', '修枝剪'],
    });
  });

  it('accepts the same legacy object through the offline input discriminator', () => {
    const legacy = readLegacyFixture();
    const parsed = parseOfflineOfferInput(legacy);

    expect(parsed.kind).toBe('single');
    if (parsed.kind === 'single') expectNoDeprecatedKeys(parsed.offer);
  });
});

function batchFor(offer: ReturnType<typeof parseOfferResult>): OfferBatchResult {
  return {
    mode: 'offers',
    total: 1,
    success: 1,
    failed: 0,
    offerIds: [offer.offerId],
    offers: [offer],
    failures: [],
  };
}

function readLegacyFixture(): Record<string, unknown> {
  return JSON.parse(fsSync.readFileSync(fixturePath, 'utf8')) as Record<string, unknown>;
}

function expectNoDeprecatedKeys(value: unknown): void {
  const found: string[] = [];
  visit(value, '$');
  expect(found).toEqual([]);

  function visit(current: unknown, location: string): void {
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${location}[${index}]`));
      return;
    }
    if (!current || typeof current !== 'object') return;
    for (const [key, child] of Object.entries(current)) {
      if (deprecatedKeys.has(key)) found.push(`${location}.${key}`);
      visit(child, `${location}.${key}`);
    }
  }
}
