import { describe, expect, it, vi } from 'vitest';
import type {
  CanonicalProductV2,
  OzonProductDraftV2,
  StorePublishProfileV1,
} from '../../../../packages/contracts/src/index.js';
import type { OzonSellerWriteTransport } from '../../../../packages/adapters-ozon/src/index.js';
import { buildListingPayload } from '../../../../packages/steps/listing-payload/src/index.js';
import { runOzonPublish } from '../../../../packages/steps/ozon-publish/src/index.js';

describe('industrial publication steps', () => {
  it('builds a stable CNY request without stock fields or invented images', () => {
    const payload = buildListingPayload({ run_id: 'run-1', product: product(), draft: draft(), profile: profile() });
    expect(payload.request.items).toHaveLength(2);
    expect(payload.request.items[0]).toMatchObject({
      currency_code: 'CNY', price: '25.00', vat: '0.2', primary_image: 'https://img.example/a.jpg', weight: 200,
    });
    expect(JSON.stringify(payload)).not.toContain('stock');
    expect(payload.request.items.every((item) => item.offer_id.length <= 50)).toBe(true);
    const repeated = buildListingPayload({ run_id: 'run-1', product: product(), draft: draft(), profile: profile() });
    expect(repeated.request_sha256).toBe(payload.request_sha256);
    expect(repeated.sku_offer_ids).toEqual(payload.sku_offer_ids);
  });

  it('blocks missing logistics facts, source images, and pricing policy', () => {
    const invalid = product();
    invalid.skus[0]!.package.raw_weight = null;
    expect(() => buildListingPayload({ run_id: 'run', product: invalid, draft: draft(), profile: profile() })).toThrow('logistics');
    const invalidProfile = profile();
    invalidProfile.pricing.markup_multiplier = 0;
    expect(() => buildListingPayload({ run_id: 'run', product: product(), draft: draft(), profile: invalidProfile })).toThrow('markup');
  });

  it('preserves successful SKUs and retries only temporary failures twice at most', async () => {
    const payload = buildListingPayload({ run_id: 'run-1', product: product(), draft: draft(), profile: profile() });
    const offers = Object.values(payload.sku_offer_ids);
    const transport: OzonSellerWriteTransport = {
      importProducts: vi.fn(async () => (transport.importProducts as ReturnType<typeof vi.fn>).mock.calls.length),
      getImportInfo: vi.fn(async (taskId: number) => taskId === 1 ? [
        { offer_id: offers[0]!, product_id: 101, status: 'imported', errors: [] },
        { offer_id: offers[1]!, product_id: 0, status: 'failed', errors: [{ code: 'TEMPORARY_UNAVAILABLE', message: 'retry' }] },
      ] : [{ offer_id: offers[1]!, product_id: 102, status: 'imported', errors: [] }]),
      getProductIdentities: vi.fn(async () => offers.map((offerId, index) => ({ offer_id: offerId, product_id: 101 + index, sku: 9001 + index }))),
    };
    const result = await runOzonPublish({ payload, profile: profile(), transport });
    expect(result.ok).toBe(true);
    expect(result.data?.task_ids).toEqual([1, 2]);
    expect(transport.importProducts).toHaveBeenNthCalledWith(2, [expect.objectContaining({ offer_id: offers[1] })], undefined);
    expect(result.data?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ offer_id: offers[0], retry_count: 0, status: 'imported', product_url: 'https://www.ozon.ru/context/detail/id/9001/' }),
      expect.objectContaining({ offer_id: offers[1], retry_count: 1, status: 'imported' }),
    ]));
  });
});

function profile(): StorePublishProfileV1 {
  return {
    schema_version: 1,
    publishing: { enabled: true, credentials_ref: 'test' },
    pricing: { currency_code: 'CNY', markup_multiplier: 2.5 },
    vat: '0.2',
    polling: { interval_ms: 100, timeout_ms: 1000, max_retries: 2 },
  };
}

function product(): CanonicalProductV2 {
  return {
    schema_version: 2,
    source: { platform: '1688', offer_id: '123456789', offer_url: 'https://detail.1688.com/offer/123456789.html', collected_at: '2026-07-14T00:00:00Z', collection_method: 'offers', detail_url: null, source_category_path_zh: [], discovery_context: { search_term: null, seed_offer_id: null } },
    product: { title_zh: '测试商品', main_image: 'https://img.example/main.jpg', gallery_images: [], attributes: {}, price_tiers: [], sku_options: [] },
    skus: ['a','b'].map((id, index) => ({ source_sku_id: id, raw_spec_text: id, specs: { 颜色: id }, unparsed_spec_segments: [], price_cny: 10 + index, multi_price_cny: null, image: `https://img.example/${id}.jpg`, package: { length_cm: 10, width_cm: 8, height_cm: 5, raw_weight: 200 + index, weight_unit: 'g', source: '1688', matched_by: 'sku_id' } })),
    sku_analysis: { has_source_skus: true, is_multi_sku: true, sku_count: 2, common_fields: {}, varying_fields: [], variant_dimensions: [], missing_fields: [], duplicate_spec_combinations: [], warnings: [] },
    validation: { status: 'valid', warnings: [], errors: [] },
  };
}

function draft(): OzonProductDraftV2 {
  return {
    schema_version: 2, source_offer_id: '123456789', status: 'draft_complete', publish_readiness: 'ready', category_snapshot_sha256: { group: 'abc' }, warnings: [], errors: [],
    items: ['a','b'].map((id) => ({ source_sku_id: id, group_id: 'group', description_category_id: 17028650, type_id: 97011, name: `Товар ${id}`, publish_readiness: 'ready', attributes: [{ id: 4180, complex_id: 0, values: [{ value: `Товар ${id}` }], provenance: 'derived', confidence: 'high', evidence: [{ source: 'agent_reasoning', field: 'title', value: id }] }] })),
  };
}
