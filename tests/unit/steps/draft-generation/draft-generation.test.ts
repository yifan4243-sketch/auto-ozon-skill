import { describe, expect, it } from 'vitest';
import { runDraftGeneration } from '../../../../packages/steps/draft-generation/src/index.js';

function input(includeTimestamp = true) {
  const description = Array.from({ length: 4 }, () =>
    'Керамическая дорожная кружка описана только по сохранённым данным поставщика и отличается цветовым вариантом.').join('\n\n');
  const attributes = [
    { id: 4180, complex_id: 0, values: [{ value: 'Кружка дорожная' }] },
    { id: 4191, complex_id: 0, values: [{ value: description }] },
    { id: 4383, complex_id: 0, values: [{ value: '300' }] },
    { id: 4497, complex_id: 0, values: [{ value: '350' }] },
    ...(includeTimestamp ? [{ id: 9048, complex_id: 0, values: [{ value: '20260716130000' }] }] : []),
    { id: 10096, complex_id: 0, values: [{ dictionary_value_id: 7, value: 'Многоцветный' }] },
  ];
  return {
    product: {
      schema_version: 2,
      source: { offer_id: '1688-offer', collected_at: '2026-07-16T00:00:00.000Z' },
      product: { main_image: 'https://img.example.com/main.jpg', gallery_images: ['https://img.example.com/main.jpg', 'https://img.example.com/second.jpg'] },
      skus: [{ source_sku_id: 'red', image: 'https://img.example.com/red.jpg' }],
    },
    category_decision: {
      schema_version: 1,
      status: 'decided',
      source_offer_id: '1688-offer',
      category_snapshot: {
        schema_version: 1, source: 'ozon-seller-api',
        captured_at: '2026-07-16T00:00:00.000Z', valid_from: '2026-07-16T00:00:00.000Z',
        valid_to: '2026-07-23T00:00:00.000Z', sha256: 'b'.repeat(64),
      },
    },
    category_attributes: [{
      group_ids: ['group-1'], category: { description_category_id: 10, type_id: 20 },
      attributes_schema: {
        snapshot: {
          schema_version: 1, source: 'ozon-seller-api',
          captured_at: '2026-07-16T00:00:00.000Z', valid_from: '2026-07-16T00:00:00.000Z',
          valid_to: '2026-07-23T00:00:00.000Z', sha256: 'a'.repeat(64),
        },
        attributes: [
        { id: 4180, dictionary_id: 0, values: [] }, { id: 4191, dictionary_id: 0, values: [] },
        { id: 4383, dictionary_id: 0, values: [] }, { id: 4497, dictionary_id: 0, values: [] },
        { id: 10096, dictionary_id: 1, values: [{ id: 7, value: 'Многоцветный' }] },
        { id: 9048, dictionary_id: 0, values: [] },
      ] },
    }],
    cost_pricing: { source_offer_id: '1688-offer', status: 'completed', sku_pricing: [{
      source_sku_id: 'red', final_price_cny: 25, package: { actual_weight_g: 300, length_cm: 20, width_cm: 10, height_cm: 8 },
      weight_facts: { semantics: 'legacy-cost-base-v1', draft_weight_g: 300 },
    }] },
    attribute_mapping: { schema_version: 2, source_offer_id: '1688-offer', status: 'completed', sku_attributes: [{
      source_sku_id: 'red', group_id: 'group-1', description_category_id: 10, type_id: 20, ozon_attributes: attributes,
    }] },
    content_bundle: {
      schema_version: 1,
      source_offer_id: '1688-offer',
      status: 'completed',
      sku_content: [{
        source_sku_id: 'red',
        title_ru: 'Кружка дорожная',
        description_ru: description,
        hashtags_ru: Array.from({ length: 20 }, (_, index) => `#кружка_${index + 1}`),
        confidence: 'high',
        evidence_refs: [{ json_pointer: '/canonical_v2/product/title_zh', value: '陶瓷杯' }],
        claims: description.split('\n\n').map((claim_text) => ({
          claim_text,
          evidence_refs: [{ json_pointer: '/canonical_v2/product/title_zh', value: '陶瓷杯' }],
        })),
      }],
      errors: [],
    },
  } as never;
}

describe('draft-generation', () => {
  it('builds Ozon-shaped items without changing mapped attributes', async () => {
    const result = await runDraftGeneration(input());
    expect(result).toMatchObject({ ok: true, data: { status: 'draft_complete' } });
    const item = result.data!.items[0]!;
    expect(item).toMatchObject({ name: 'Кружка дорожная', price: '25.00', weight: 300, depth: 200, width: 100, height: 80, primary_image: item.images[0], currency_code: 'CNY' });
    expect(item.images).toEqual(['https://img.example.com/red.jpg', 'https://img.example.com/main.jpg', 'https://img.example.com/second.jpg']);
    expect(item.attributes).toEqual(input().attribute_mapping.sku_attributes[0].ozon_attributes);
  });

  it('blocks when current category exposes 9048 but mapping omitted it', async () => {
    const result = await runDraftGeneration(input(false));
    expect(result).toMatchObject({ ok: false, data: { status: 'blocked', errors: [{ code: 'TIMESTAMP_9048_MISSING' }] } });
  });

  it('blocks weight drift between pricing, attributes, and the draft request', async () => {
    const fixture = input();
    fixture.attribute_mapping.sku_attributes[0].ozon_attributes.find((attribute: { id: number }) => attribute.id === 4497).values[0].value = '349';
    const result = await runDraftGeneration(fixture);
    expect(result).toMatchObject({ ok: false, data: { status: 'blocked', errors: [{ code: 'WEIGHT_4497_INCONSISTENT' }] } });
  });
});
