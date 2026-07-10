import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { OfferResult } from '../../../packages/adapters-1688/src/engine/commands/offers.js';
import { offerToCanonicalV2 } from '../../../packages/adapters-1688/src/mappers/offer-to-canonical-v2.js';
import { parseSkuSpec } from '../../../packages/transformer/src/sku-spec-parser.js';

type OfferFixtureOverride = Partial<Omit<OfferResult, 'supplier' | 'freight'>> & {
  supplier?: Partial<OfferResult['supplier']>;
  freight?: Partial<OfferResult['freight']>;
};

describe('CanonicalProductV2 SKU normalization fixtures', () => {
  it('no-sku-product creates one DEFAULT SKU without claiming a source SKU', () => {
    const result = convert('no-sku-product');

    expect(result.skus).toHaveLength(1);
    expect(result.skus[0]).toMatchObject({
      source_sku_id: 'DEFAULT',
      raw_spec_text: '',
      specs: {},
      price_cny: 3.2,
      multi_price_cny: null,
      supplier_stock: null,
      sale_count: null,
      image: 'https://img.example.com/default.jpg',
      package: { length_cm: 12, raw_weight: 120, matched_by: 'none' },
    });
    expect(result.sku_analysis).toMatchObject({
      has_source_skus: false,
      is_multi_sku: false,
      sku_count: 1,
    });
  });

  it('single-sku-product preserves the real skuId and uses exact spec fallback', () => {
    const result = convert('single-sku-product');

    expect(result.skus).toHaveLength(1);
    expect(result.skus[0]).toMatchObject({
      source_sku_id: 'real-sku-1',
      specs: { 规格: '标准款' },
      supplier_stock: 88,
      sale_count: 9,
      package: { length_cm: 20, matched_by: 'exact_spec' },
    });
    expect(result.sku_analysis.has_source_skus).toBe(true);
    expect(result.sku_analysis.is_multi_sku).toBe(false);
  });

  it('color-variants marks color as a distinguishing source dimension', () => {
    const result = convert('color-variants');
    expect(result.skus.map((sku) => sku.specs)).toEqual([
      { 颜色: '红色' },
      { 颜色: '蓝色' },
    ]);
    expect(dimension(result, '颜色')).toEqual({
      source_name: '颜色',
      values: ['红色', '蓝色'],
      distinguishes_skus: true,
      missing_for_skus: [],
    });
  });

  it('color-size-variants analyzes both dimensions without spec1/spec2 keys', () => {
    const result = convert('color-size-variants');
    expect(dimension(result, '颜色')?.distinguishes_skus).toBe(true);
    expect(dimension(result, '尺码')?.distinguishes_skus).toBe(true);
    expect(dimension(result, '颜色')?.values).toEqual(['红色', '蓝色']);
    expect(dimension(result, '尺码')?.values).toEqual(['M', 'L']);
    expect(Object.keys(result.skus[0]!.specs)).toEqual(['颜色', '尺码']);
  });

  it('same-package-for-all-skus retains an independent package per SKU and summarizes it', () => {
    const result = convert('same-package-for-all-skus');
    expect(result.skus[0]!.package).not.toBe(result.skus[1]!.package);
    expect(result.skus.map((sku) => sku.package.raw_weight)).toEqual([500, 500]);
    expect(result.skus.every((sku) => sku.package.matched_by === 'sku_id')).toBe(true);
    expect(result.sku_analysis.common_fields).toMatchObject({
      'package.length_cm': 30,
      'package.raw_weight': 500,
      'package.volume_cm3': 6000,
    });
  });

  it('different-package-per-sku records package differences by source skuId', () => {
    const result = convert('different-package-per-sku');
    const varyingLength = result.sku_analysis.varying_fields.find(
      (entry) => entry.field === 'package.length_cm',
    );
    expect(result.skus.map((sku) => sku.package.length_cm)).toEqual([20, 40]);
    expect(varyingLength?.values_by_sku).toEqual({ small: 20, large: 40 });
  });

  it('partially-missing-package never inherits another SKU package', () => {
    const result = convert('partially-missing-package');
    const missingSku = result.skus.find((sku) => sku.source_sku_id === 'pkg-blue');
    expect(missingSku?.package).toEqual({
      length_cm: null,
      width_cm: null,
      height_cm: null,
      raw_weight: null,
      weight_unit: 'unknown',
      volume_cm3: null,
      source: '1688',
      matched_by: 'none',
    });
    expect(result.sku_analysis.missing_fields).toContainEqual({
      field: 'package',
      sku_ids: ['pkg-blue'],
    });
  });

  it('multi-price preserves source multiPrice, saleCount, and stock', () => {
    const result = convert('multi-price');
    expect(result.skus[0]).toMatchObject({
      multi_price_cny: 9.5,
      supplier_stock: 100,
      sale_count: 80,
    });
  });

  it('sku-order-changed matches packages by skuId instead of array index', () => {
    const result = convert('sku-order-changed');
    expect(result.skus.map((sku) => [sku.source_sku_id, sku.package.length_cm])).toEqual([
      ['order-blue', 22],
      ['order-red', 11],
    ]);
  });

  it('unknown-weight-unit preserves the raw weight and does not infer a unit', () => {
    const result = convert('unknown-weight-unit');
    expect(result.skus[0]!.package).toMatchObject({
      raw_weight: 500,
      weight_unit: 'unknown',
    });
    expect(result.sku_analysis.missing_fields).toContainEqual({
      field: 'package.weight_unit',
      sku_ids: ['unknown-unit'],
    });
  });

  it('duplicate-spec-combinations reports duplicate complete specs and review status', () => {
    const result = convert('duplicate-spec-combinations');
    expect(result.sku_analysis.duplicate_spec_combinations).toEqual([
      {
        sku_ids: ['duplicate-a', 'duplicate-b'],
        specs: { 颜色: '红色' },
      },
    ]);
    expect(result.validation.status).toBe('needs_review');
  });

  it('detail-url-is-not-image keeps detail, gallery, and SKU image roles separate', () => {
    const result = convert('detail-url-is-not-image');
    expect(result.source.detail_url).toBe('https://cbu01.alicdn.com/detail-only.html');
    expect(result.source.source_category_id).toBe('201128');
    expect(result.product.gallery_images).toEqual([
      'https://img.example.com/main.jpg',
      'https://img.example.com/gallery.jpg',
    ]);
    expect(result.product.gallery_images).not.toContain(result.skus[0]!.image);
  });
});

describe('deterministic SKU specification parsing', () => {
  it('uses a single real source dimension for an undelimited value', () => {
    expect(
      parseSkuSpec({
        raw_spec_text: '红色9寸',
        options: [{ prop: '规格', values: [] }],
      }),
    ).toEqual({ specs: { 规格: '红色9寸' }, unparsed_spec_segments: [] });
  });

  it('retains ambiguous segments instead of inventing numbered dimensions', () => {
    expect(parseSkuSpec({ raw_spec_text: '红色>9寸', options: [] })).toEqual({
      specs: {},
      unparsed_spec_segments: ['红色', '9寸'],
    });
  });
});

function convert(name: string) {
  return offerToCanonicalV2(
    loadOfferFixture(name),
    'offers',
    '2026-07-10T00:00:00.000Z',
  );
}

function loadOfferFixture(name: string): OfferResult {
  const base = readJson<OfferResult>('../../fixtures/1688/offer-result.json');
  const fixture = readJson<{ offer: OfferFixtureOverride }>(
    `../../fixtures/1688/canonical-v2/${name}.json`,
  );
  const offerId = fixture.offer.offerId ?? base.offerId;
  return {
    ...base,
    ...fixture.offer,
    offerId,
    url:
      fixture.offer.url ??
      `https://detail.1688.com/offer/${encodeURIComponent(offerId)}.html`,
    supplier: { ...base.supplier, ...fixture.offer.supplier },
    freight: { ...base.freight, ...fixture.offer.freight },
  };
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(
    fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8'),
  ) as T;
}

function dimension(
  result: ReturnType<typeof offerToCanonicalV2>,
  sourceName: string,
) {
  return result.sku_analysis.variant_dimensions.find(
    (entry) => entry.source_name === sourceName,
  );
}
