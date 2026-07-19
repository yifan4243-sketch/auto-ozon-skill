import { describe, expect, it } from 'vitest';
import type {
  AttributeMappingV2,
  CanonicalProductV2,
  CategoryAttributesGroupV1,
  CategoryDecisionV1,
  ContentBundleV1,
  CostPricingV1,
  ImageBundleV1,
  ListingDraftV2,
  StoreProfileV2,
} from '../../../../packages/contracts/src/index.js';
import { stableHash, validatePublishPreflight } from '../../../../packages/steps/listing-submit/src/index.js';

describe('publish preflight', () => {
  it('passes a complete V2 draft against current immutable artifacts and a real dictionary snapshot', () => {
    const fixture = completeFixture();
    const report = validatePublishPreflight({ run_id: 'run-1', ...fixture, now: '2026-07-17T00:00:00.000Z' });
    expect(report.status).toBe('passed');
    expect(report.checks.every((check) => check.status === 'passed')).toBe(true);
  });

  it('blocks expired snapshots and invented dictionary IDs', () => {
    const fixture = completeFixture('2026-07-16T00:00:00.000Z');
    fixture.draft.items[0]!.attributes[0]!.values[0]!.dictionary_value_id = 999;
    const report = validatePublishPreflight({ run_id: 'run-1', ...fixture, now: '2026-07-17T00:00:00.000Z' });
    expect(report.status).toBe('blocked');
    expect(report.checks.filter((check) => check.status === 'failed').map((check) => check.code)).toEqual(expect.arrayContaining(['ATTRIBUTES', 'CATEGORY_SNAPSHOT_FRESH']));
  });

  it.each([
    ['missing sku_bindings', (draft: Record<string, unknown>) => { delete draft.sku_bindings; }],
    ['invalid sku_bindings type', (draft: Record<string, unknown>) => { draft.sku_bindings = {}; }],
    ['missing artifact_hashes', (draft: Record<string, unknown>) => { delete draft.artifact_hashes; }],
    ['missing category snapshot', (draft: Record<string, unknown>) => { delete draft.category_tree_snapshot; }],
  ])('returns DRAFT_SCHEMA without throwing for %s', (_name, mutate) => {
    const fixture = completeFixture();
    const damaged = structuredClone(fixture.draft) as unknown as Record<string, unknown>;
    mutate(damaged);
    expect(() => validatePublishPreflight({ run_id: 'run-1', ...fixture, draft: damaged })).not.toThrow();
    const report = validatePublishPreflight({ run_id: 'run-1', ...fixture, draft: damaged });
    expect(report.status).toBe('blocked');
    expect(report.checks).toEqual([expect.objectContaining({ code: 'DRAFT_SCHEMA', status: 'failed' })]);
  });

  it('rejects legacy ListingDraftV1 without dereferencing V2 fields', () => {
    const fixture = completeFixture();
    const report = validatePublishPreflight({ run_id: 'run-1', ...fixture, draft: { schema_version: 1 } });
    expect(report.status).toBe('blocked');
    expect(report.checks[0]?.message).toContain('LEGACY_DRAFT_CONTRACT_UNSUPPORTED');
  });

  it('blocks a draft whose 4191 description contains Chinese source text', () => {
    const fixture = completeFixture();
    fixture.draft.items[0]!.attributes.push({
      id: 4191,
      complex_id: 0,
      values: [{ value: 'Описание варианта поставщика 红色圆口.' }],
    });
    const report = validatePublishPreflight({ run_id: 'run-1', ...fixture, now: '2026-07-17T00:00:00.000Z' });
    expect(report.status).toBe('blocked');
    expect(report.checks).toContainEqual(expect.objectContaining({
      code: 'DESCRIPTION_4191_CHARACTERS',
      status: 'failed',
    }));
  });
});

function completeFixture(validTo = '2026-07-18T00:00:00.000Z') {
  const snapshot = {
    schema_version: 1 as const,
    source: 'ozon-seller-api' as const,
    captured_at: '2026-07-17T00:00:00.000Z',
    valid_from: '2026-07-17T00:00:00.000Z',
    valid_to: validTo,
    sha256: 'a'.repeat(64),
  };
  const category_attributes = categoryAttributes(validTo);
  const product = { schema_version: 2, source: { offer_id: '1688' }, skus: [{ source_sku_id: 'sku-a' }] } as unknown as CanonicalProductV2;
  const category_decision = { schema_version: 1, source_offer_id: '1688', status: 'decided', category_snapshot: snapshot } as unknown as CategoryDecisionV1;
  const pricing = { schema_version: 1, source_offer_id: '1688', status: 'completed', sku_pricing: [{ source_sku_id: 'sku-a', estimated_profit_margin_percent: 30 }] } as unknown as CostPricingV1;
  const attributes = { schema_version: 2, source_offer_id: '1688', status: 'completed', sku_attributes: [{ source_sku_id: 'sku-a' }] } as unknown as AttributeMappingV2;
  const content = { schema_version: 1, source_offer_id: '1688', status: 'completed', sku_content: [{ source_sku_id: 'sku-a' }], errors: [] } as unknown as ContentBundleV1;
  const images = { schema_version: 1, source_offer_id: '1688', status: 'completed', sku_images: [{ source_sku_id: 'sku-a' }] } as unknown as ImageBundleV1;
  const draft: ListingDraftV2 = {
    schema_version: 2,
    source_offer_id: '1688',
    status: 'draft_complete',
    generated_at: '2026-07-17T00:00:00.000Z',
    weight_semantics: 'legacy-cost-base-v1',
    artifact_hashes: {
      canonical_product_sha256: stableHash(product),
      category_decision_sha256: stableHash(category_decision),
      cost_pricing_sha256: stableHash(pricing),
      category_attributes_sha256: stableHash(category_attributes),
      attribute_mapping_sha256: stableHash(attributes),
      content_bundle_sha256: stableHash(content),
      image_bundle_sha256: stableHash(images),
    },
    category_tree_snapshot: snapshot,
    attribute_snapshot_refs: [{
      group_ids: ['g'], description_category_id: 10, type_id: 20,
      captured_at: snapshot.captured_at, valid_from: snapshot.valid_from,
      valid_to: snapshot.valid_to, sha256: snapshot.sha256,
    }],
    sku_bindings: [{ source_sku_id: 'sku-a', offer_id: 'offer-a' }],
    warnings: [],
    errors: [],
    items: [{
      offer_id: 'offer-a', name: 'Товар', price: '100.00', description_category_id: 10, type_id: 20,
      weight: 100, depth: 100, width: 100, height: 100, dimension_unit: 'mm', weight_unit: 'g',
      images: ['https://img.test/a.jpg'], primary_image: 'https://img.test/a.jpg', complex_attributes: [], currency_code: 'CNY',
      attributes: [{ id: 85, complex_id: 0, values: [{ dictionary_value_id: 126745801, value: 'Нет бренда' }] },
        { id: 4191, complex_id: 0, values: [{ value: 'Подробное описание товара на русском языке.' }] },
        { id: 4383, complex_id: 0, values: [{ value: '100' }] }, { id: 4497, complex_id: 0, values: [{ value: '150' }] },
        { id: 9048, complex_id: 0, values: [{ value: '20260717080000' }] }],
    }],
  };
  return { draft, store, pricing, attributes, category_attributes, product, category_decision, content, images };
}

const store = {
  schema_version: 2, store_id: '500', store_name: 'test', market: 'RU', currency_code: 'CNY',
  credentials: { client_id: { provider: 'env', key: 'OZON_CLIENT_ID' }, api_key: { provider: 'env', key: 'OZON_API_KEY' } },
  publishing: { enabled: true, automation_level: 'automatic', allowed_description_category_ids: [10], max_items_per_batch: 100, daily_listing_limit: 100 },
  pricing: { mode: 'multiplier', multiplier: '2', minimum_margin_percent: '10', advertising_reserve_percent: '0', return_loss_reserve_percent: '0', other_rate_percent: '10', label_fee_cny: '2', other_fixed_cny: '0' },
  polling: { timeout_ms: 100, interval_ms: 0, max_recoverable_retries: 2 },
} as StoreProfileV2;

function categoryAttributes(validTo: string): CategoryAttributesGroupV1[] {
  return [{ group_ids: ['g'], category: { description_category_id: 10, description_category_name: '商品', type_id: 20, type_name: '商品', category_path_zh: ['商品'] },
    attributes_schema: { schema_version: 1, source: 'ozon', language: 'ZH_HANS', ok: true, fetched_at: '2026-07-17T00:00:00.000Z',
      snapshot: { schema_version: 1, source: 'ozon-seller-api', captured_at: '2026-07-17T00:00:00.000Z', valid_from: '2026-07-17T00:00:00.000Z', valid_to: validTo, sha256: 'a'.repeat(64) },
      category: { description_category_id: 10, type_id: 20 }, raw_response: {}, dictionary_raw_responses: {},
      attributes: [{ id: 85, name: '品牌', description: '', type: 'string', required: true, is_collection: false, is_aspect: false, dictionary_id: 1, group_id: 0, group_name: '', category_dependent: false, values: [{ id: 126745801, value: 'Нет бренда' }] },
        ...[4191, 4383, 4497, 9048].map((id) => ({ id, name: String(id), description: '', type: 'string', required: true, is_collection: false, is_aspect: false, dictionary_id: 0, group_id: 0, group_name: '', category_dependent: false, values: [] }))] } }];
}
