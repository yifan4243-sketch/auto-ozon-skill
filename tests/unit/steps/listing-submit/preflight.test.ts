import { describe, expect, it } from 'vitest';
import type { AttributeMappingV1, CategoryAttributesGroupV1, CostPricingV1, ListingDraftV1, StoreProfileV2 } from '../../../../packages/contracts/src/index.js';
import { validatePublishPreflight } from '../../../../packages/steps/listing-submit/src/index.js';

describe('publish preflight', () => {
  it('passes a complete draft against a current real dictionary snapshot', () => {
    const report = validatePublishPreflight({ run_id: 'run-1', draft, store, pricing, attributes, category_attributes: categoryAttributes(), now: '2026-07-17T00:00:00.000Z' });
    expect(report.status).toBe('passed');
    expect(report.checks.every((check) => check.status === 'passed')).toBe(true);
  });

  it('blocks expired snapshots and invented dictionary IDs', () => {
    const invalidDraft = structuredClone(draft);
    invalidDraft.items[0]!.attributes[0]!.values[0]!.dictionary_value_id = 999;
    const snapshots = categoryAttributes('2026-07-16T00:00:00.000Z');
    const report = validatePublishPreflight({ run_id: 'run-1', draft: invalidDraft, store, pricing, attributes, category_attributes: snapshots, now: '2026-07-17T00:00:00.000Z' });
    expect(report.status).toBe('blocked');
    expect(report.checks.filter((check) => check.status === 'failed').map((check) => check.code)).toEqual(expect.arrayContaining(['ATTRIBUTES', 'CATEGORY_SNAPSHOT_FRESH']));
  });
});

const draft = {
  schema_version: 1, source_offer_id: '1688', status: 'draft_complete', weight_semantics: 'legacy-cost-base-v1', image_bundle_sha256: 'hash', warnings: [], errors: [],
  items: [{ offer_id: 'offer-a', name: 'Товар', price: '100.00', description_category_id: 10, type_id: 20, weight: 100, depth: 100, width: 100, height: 100,
    dimension_unit: 'mm', weight_unit: 'g', images: ['https://img.test/a.jpg'], primary_image: 'https://img.test/a.jpg', complex_attributes: [], currency_code: 'CNY',
    attributes: [{ id: 85, complex_id: 0, values: [{ dictionary_value_id: 126745801, value: 'Нет бренда' }] },
      { id: 4383, complex_id: 0, values: [{ value: '100' }] }, { id: 4497, complex_id: 0, values: [{ value: '150' }] },
      { id: 9048, complex_id: 0, values: [{ value: '20260717080000' }] }] }],
} as unknown as ListingDraftV1;

const store = {
  schema_version: 2, store_id: '500', store_name: 'test', market: 'RU', currency_code: 'CNY',
  credentials: { client_id: { provider: 'env', key: 'OZON_CLIENT_ID' }, api_key: { provider: 'env', key: 'OZON_API_KEY' } },
  publishing: { enabled: true, automation_level: 'automatic', allowed_description_category_ids: [10], max_items_per_batch: 100, daily_listing_limit: 100 },
  pricing: { mode: 'multiplier', multiplier: '2', minimum_margin_percent: '10', advertising_reserve_percent: '0', return_loss_reserve_percent: '0', other_rate_percent: '10', label_fee_cny: '2', other_fixed_cny: '0' },
  polling: { timeout_ms: 100, interval_ms: 0, max_recoverable_retries: 2 },
} as StoreProfileV2;

const pricing = { status: 'completed', sku_pricing: [{ estimated_profit_margin_percent: 30 }] } as unknown as CostPricingV1;
const attributes = { status: 'completed' } as unknown as AttributeMappingV1;
function categoryAttributes(validTo = '2026-07-18T00:00:00.000Z'): CategoryAttributesGroupV1[] {
  return [{ group_ids: ['g'], category: { description_category_id: 10, description_category_name: '商品', type_id: 20, type_name: '商品', category_path_zh: ['商品'] },
    attributes_schema: { schema_version: 1, source: 'ozon', language: 'ZH_HANS', ok: true, fetched_at: '2026-07-17T00:00:00.000Z',
      snapshot: { schema_version: 1, source: 'ozon-seller-api', captured_at: '2026-07-17T00:00:00.000Z', valid_from: '2026-07-17T00:00:00.000Z', valid_to: validTo, sha256: 'snapshot' },
      category: { description_category_id: 10, type_id: 20 }, raw_response: {}, dictionary_raw_responses: {},
      attributes: [{ id: 85, name: '品牌', description: '', type: 'string', required: true, is_collection: false, is_aspect: false, dictionary_id: 1, group_id: 0, group_name: '', category_dependent: false, values: [{ id: 126745801, value: 'Нет бренда' }] },
        ...[4383, 4497, 9048].map((id) => ({ id, name: String(id), description: '', type: 'string', required: true, is_collection: false, is_aspect: false, dictionary_id: 0, group_id: 0, group_name: '', category_dependent: false, values: [] }))] } }];
}
