import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { OfferResult } from '../../../packages/adapters-1688/src/engine/commands/offers.js';
import { offerToCanonicalV2 } from '../../../packages/adapters-1688/src/mappers/offer-to-canonical-v2.js';
import { checkCanonicalV2Integrity } from '../../../packages/transformer/src/canonical-v2-integrity.js';

describe('CanonicalProductV2 integrity checks', () => {
  it('passes an unchanged deterministic conversion', () => {
    const { offer, product } = convertedFixture();
    const report = checkCanonicalV2Integrity([offer], [product]);

    expect(report.status).toBe('pass');
    expect(report.checked_product_count).toBe(1);
    expect(report.violations).toEqual([]);
    expect(report.product_results[0]).toMatchObject({
      offer_id: offer.offerId,
      passed: true,
      source_sku_count: 1,
      expected_canonical_sku_count: 1,
      canonical_sku_count: 1,
    });
  });

  it('fails when a canonical SKU disappears', () => {
    const { offer, product } = convertedFixture();
    product.skus = [];

    const report = checkCanonicalV2Integrity([offer], [product]);
    expect(report.status).toBe('fail');
    expect(codes(report)).toContain('SKU_COUNT_MISMATCH');
  });

  it('fails when a source SKU price changes', () => {
    const { offer, product } = convertedFixture();
    product.skus[0]!.price_cny = 999;

    const report = checkCanonicalV2Integrity([offer], [product]);
    expect(report.status).toBe('fail');
    expect(codes(report)).toContain('SKU_PRICE_MISMATCH');
  });

  it('fails when detail_url enters gallery_images', () => {
    const { offer, product } = convertedFixture();
    product.product.gallery_images.push(offer.detailUrl!);

    const report = checkCanonicalV2Integrity([offer], [product]);
    expect(report.status).toBe('fail');
    expect(codes(report)).toContain('DETAIL_URL_IN_GALLERY');
  });

  it('fails when a sub-three weight is preserved or converted', () => {
    const { offer, product } = convertedFixture();
    offer.packageInfo[0]!.weight = 2.99;
    product.skus[0]!.package.raw_weight = 2.99;

    const report = checkCanonicalV2Integrity([offer], [product]);
    expect(report.status).toBe('fail');
    expect(codes(report)).toContain('PACKAGE_WEIGHT_MISMATCH');
  });

  it('fails when invalid source SKU IDs are not blocked', () => {
    const { offer, product } = convertedFixture();
    offer.skus[0]!.skuId = '';
    product.skus[0]!.source_sku_id = '';
    product.validation.status = 'warning';

    const report = checkCanonicalV2Integrity([offer], [product]);
    expect(report.status).toBe('fail');
    expect(codes(report)).toContain('INVALID_SKU_ID_NOT_BLOCKED');
  });

  it('fails when a successfully collected product disappears', () => {
    const { offer } = convertedFixture();
    const report = checkCanonicalV2Integrity([offer], []);

    expect(report.status).toBe('fail');
    expect(codes(report)).toContain('MISSING_CANONICAL_PRODUCT');
  });

  it('checks DEFAULT SKU price and image preservation for no-SKU offers', () => {
    const { offer } = convertedFixture();
    offer.skus = [];
    const product = offerToCanonicalV2(offer, 'offers');
    product.skus[0]!.price_cny = 999;
    product.skus[0]!.image = 'https://img.example.com/changed.jpg';

    const report = checkCanonicalV2Integrity([offer], [product]);

    expect(report.status).toBe('fail');
    expect(codes(report)).toContain('DEFAULT_SKU_PRICE_MISMATCH');
    expect(codes(report)).toContain('DEFAULT_SKU_IMAGE_MISMATCH');
  });
});

function convertedFixture() {
  const offer = readFixture<OfferResult>('offer-result.json');
  const product = offerToCanonicalV2(
    offer,
    'offers',
    '2026-07-10T00:00:00.000Z',
    { searchTerm: null, seedOfferId: null },
  );
  return { offer: structuredClone(offer), product: structuredClone(product) };
}

function codes(report: ReturnType<typeof checkCanonicalV2Integrity>): string[] {
  return report.violations.map((violation) => violation.code);
}

function readFixture<T>(name: string): T {
  return JSON.parse(
    fs.readFileSync(new URL(`../../fixtures/1688/${name}`, import.meta.url), 'utf8'),
  ) as T;
}
