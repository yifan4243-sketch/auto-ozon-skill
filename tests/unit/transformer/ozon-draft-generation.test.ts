import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  CanonicalProductV2,
  CategoryAttributeV1,
  CategoryAttributesV1,
  CategoryDecisionV1,
  OzonDraftAgentInputV1,
  OzonDraftCategoryAttributesGroupV1,
} from '../../../packages/contracts/src/index.js';
import { getProductWorkspacePaths } from '../../../packages/core/src/product-workspace.js';
import { saveOzonDraftBundle } from '../../../packages/publishing/src/draft-store.js';
import {
  buildOzonProductDraft,
  normalizeDraftNetWeight,
  OZON_DRAFT_ATTRIBUTE_IDS,
  OZON_DRAFT_ATTRIBUTE_RULES,
} from '../../../packages/transformer/src/index.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const temporaryDirectories: string[] = [];
const evidence = [{ source: 'canonical_v2' as const, field: 'product.title_zh', value: '户外净水器' }];
const hashtags = [
  '#поход', '#туризм', '#фильтр', '#чистая_вода', '#путешествие',
  '#кемпинг', '#природа', '#активный_отдых', '#снаряжение', '#выживание',
  '#питьевая_вода', '#очистка_воды', '#походная_кухня', '#рыбалка', '#охота',
  '#дача', '#пикник', '#рюкзак', '#дорога', '#безопасная_вода',
];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fsPromises.rm(directory, { recursive: true, force: true }),
  ));
});

describe('Ozon draft Skill', () => {
  it('is routed from the repository and keeps one fixed output schema', () => {
    const skillPath = 'packages/transformer/skills/ozon-draft-generation/SKILL.md';
    expect(fs.readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf8')).toContain(skillPath);
    expect(fs.readFileSync(path.join(repoRoot, 'SKILL.md'), 'utf8')).toContain(skillPath);
    const schema = JSON.parse(fs.readFileSync(path.join(
      repoRoot,
      'packages/transformer/skills/ozon-draft-generation/output.schema.json',
    ), 'utf8')) as { title: string };
    expect(schema.title).toBe('OzonProductDraftV1');
  });

  it('keeps all V0 behavior in one rule table', () => {
    expect(OZON_DRAFT_ATTRIBUTE_RULES[85]?.default_dictionary_value_id).toBe(126745801);
    expect(OZON_DRAFT_ATTRIBUTE_RULES[4389]?.default_dictionary_value_id).toBe(90296);
    expect(OZON_DRAFT_ATTRIBUTE_RULES[10096]?.default_dictionary_value_id).toBe(369939085);
    expect(OZON_DRAFT_ATTRIBUTE_RULES[8789]?.action).toBe('omit');
    expect(OZON_DRAFT_ATTRIBUTE_RULES[9024]?.action).toBe('omit');
    expect(OZON_DRAFT_ATTRIBUTE_RULES[11254]?.action).toBe('omit');
  });
});

describe('draft weight normalization', () => {
  it('keeps grams, converts kilograms, and only estimates missing or unknown weight', () => {
    expect(normalizeDraftNetWeight(320, 'g')).toMatchObject({ grams: 320, provenance: 'source' });
    expect(normalizeDraftNetWeight(0.5, 'kg')).toMatchObject({ grams: 500, provenance: 'converted' });
    expect(normalizeDraftNetWeight(0.5, 'unknown', decision(450, 'medium')))
      .toMatchObject({ grams: 450, provenance: 'agent_estimated' });
    expect(normalizeDraftNetWeight(null, 'unknown', decision(600, 'medium')))
      .toMatchObject({ grams: 600, provenance: 'agent_estimated' });
    expect(normalizeDraftNetWeight(null, 'unknown')).toBeNull();
  });
});

describe('Ozon draft mapping', () => {
  it.each([
    ['single SKU', 1, 'single_sku' as const],
    ['normal variants', 2, 'normal_variants' as const],
    ['mixed product', 1, 'mixed_product' as const],
  ])('builds a completed %s draft', (_label, skuCount, structure) => {
    const fixture = createFixture(skuCount, structure);
    const result = buildOzonProductDraft(fixture);

    expect(result.validation).toMatchObject({ status: 'completed', valid: true, issues: [] });
    expect(result.draft.items).toHaveLength(skuCount);
    for (const item of result.draft.items) {
      expect(dictionaryId(item, 85)).toBe(126745801);
      expect(dictionaryId(item, 4389)).toBe(90296);
      expect(dictionaryId(item, 10096)).toBe(369939085);
      expect(dictionaryId(item, 8229)).toBe(94600);
      expect(valueOf(item, 4383)).toBe('500');
      expect(valueOf(item, 4497)).toBe('550');
      expect(valueOf(item, 9048)).toBe(
        structure === 'mixed_product' ? `${fixture.product.source.offer_id}-main` : fixture.product.source.offer_id,
      );
      expect(valueOf(item, 11650)).toBe('1');
      expect(item.attributes.map((attribute) => attribute.id)).not.toEqual(
        expect.arrayContaining([8789, 9024, 11254, 23249]),
      );
    }
  });

  it('marks Agent-estimated weight for review without mutating CanonicalProductV2', () => {
    const fixture = createFixture();
    fixture.product.skus[0]!.package.raw_weight = null;
    fixture.product.skus[0]!.package.weight_unit = 'unknown';
    fixture.agentInput.sku_inputs[0]!.estimated_weight_grams = decision(430, 'medium');
    const original = structuredClone(fixture.product);

    const result = buildOzonProductDraft(fixture);

    expect(result.validation.status).toBe('needs_review');
    expect(result.validation.issues.map((entry) => entry.code)).toContain('AGENT_ESTIMATED_ATTRIBUTE');
    expect(valueOf(result.draft.items[0]!, 4383)).toBe('430');
    expect(valueOf(result.draft.items[0]!, 4497)).toBe('480');
    expect(fixture.product).toEqual(original);
  });

  it('blocks invalid dictionaries and unsupported required attributes', () => {
    const invalidDictionary = createFixture();
    invalidDictionary.agentInput.sku_inputs[0]!.product_type.value.dictionary_value_id = 999999;
    expect(codes(buildOzonProductDraft(invalidDictionary))).toContain('DICTIONARY_VALUE_NOT_FOUND');

    const unsupported = createFixture();
    unsupported.categoryAttributeGroups[0]!.attributes_schema.attributes.push(
      attribute(999001, { required: true }),
    );
    expect(codes(buildOzonProductDraft(unsupported))).toContain('UNSUPPORTED_REQUIRED_ATTRIBUTE');
  });

  it('blocks missing or duplicate SKU coverage and missing attribute 8229', () => {
    const missing = createFixture();
    missing.categoryDecision.category_groups[0]!.source_sku_ids = [];
    expect(codes(buildOzonProductDraft(missing))).toContain('MISSING_CATEGORY_SKU_COVERAGE');

    const duplicate = createFixture();
    duplicate.categoryDecision.category_groups.push({
      ...structuredClone(duplicate.categoryDecision.category_groups[0]!),
      group_id: 'duplicate',
    });
    duplicate.categoryAttributeGroups[0]!.group_ids.push('duplicate');
    expect(codes(buildOzonProductDraft(duplicate))).toContain('DUPLICATE_SKU_ASSIGNMENT');

    const duplicateSource = createFixture();
    duplicateSource.product.skus.push(structuredClone(duplicateSource.product.skus[0]!));
    expect(codes(buildOzonProductDraft(duplicateSource))).toContain('DUPLICATE_SOURCE_SKU');

    const unassigned = createFixture();
    unassigned.categoryDecision.unassigned_sku_ids = ['filter-1'];
    expect(codes(buildOzonProductDraft(unassigned))).toContain('UNASSIGNED_CATEGORY_SKU');

    const noType = createFixture();
    noType.categoryAttributeGroups[0]!.attributes_schema.attributes =
      noType.categoryAttributeGroups[0]!.attributes_schema.attributes.filter(
        (entry) => entry.id !== OZON_DRAFT_ATTRIBUTE_IDS.productType,
      );
    expect(codes(buildOzonProductDraft(noType))).toContain('PRODUCT_TYPE_ATTRIBUTE_NOT_AVAILABLE');
  });

  it('blocks invalid Russian copy and uses low confidence as review', () => {
    const invalid = createFixture();
    invalid.agentInput.sku_inputs[0]!.hashtags_ru.value = ['#мало'];
    expect(codes(buildOzonProductDraft(invalid))).toContain('HASHTAGS_INVALID');

    const review = createFixture();
    review.agentInput.sku_inputs[0]!.product_type.confidence = 'low';
    expect(buildOzonProductDraft(review).validation.status).toBe('needs_review');
  });

  it('stores draft.json and validation.json in the product workspace', async () => {
    const fixture = createFixture();
    const result = buildOzonProductDraft(fixture);
    const productsDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'auto-ozon-draft-'));
    temporaryDirectories.push(productsDir);

    await saveOzonDraftBundle(
      { offerId: fixture.product.source.offer_id, productsDir },
      result.draft,
      result.validation,
    );
    const paths = getProductWorkspacePaths(fixture.product.source.offer_id, productsDir);
    expect(JSON.parse(await fsPromises.readFile(paths.artifacts.ozon_draft, 'utf8'))).toEqual(result.draft);
    expect(JSON.parse(await fsPromises.readFile(paths.artifacts.draft_validation, 'utf8'))).toEqual(result.validation);
  });
});

function createFixture(
  skuCount = 1,
  structure: CategoryDecisionV1['product_structure'] = 'single_sku',
) {
  const skuIds = Array.from({ length: skuCount }, (_, index) => `filter-${index + 1}`);
  const product: CanonicalProductV2 = {
    schema_version: 2,
    source: {
      platform: '1688', offer_id: '900000000010',
      offer_url: 'https://detail.1688.com/offer/900000000010.html',
      collected_at: '2026-07-13T00:00:00.000Z', collection_method: 'offers',
      detail_url: null, source_category_path_zh: ['运动户外', '净水器'],
      discovery_context: { search_term: '户外净水器', seed_offer_id: null },
    },
    product: {
      title_zh: '户外便携净水器', main_image: null, gallery_images: [],
      attributes: { 材质: '塑料' }, price_tiers: [], sku_options: [],
    },
    skus: skuIds.map((source_sku_id) => ({
      source_sku_id, raw_spec_text: '默认', specs: { 规格: '默认' },
      unparsed_spec_segments: [], price_cny: 20, multi_price_cny: null, image: null,
      package: {
        length_cm: 15, width_cm: 8, height_cm: 5, raw_weight: 0.5,
        weight_unit: 'kg', source: '1688', matched_by: 'sku_id',
      },
    })),
    sku_analysis: {
      has_source_skus: true, is_multi_sku: skuCount > 1, sku_count: skuCount,
      common_fields: {}, varying_fields: [], variant_dimensions: [], missing_fields: [],
      duplicate_spec_combinations: [], warnings: [],
    },
    validation: { status: 'valid', warnings: [], errors: [] },
  };
  const selected = {
    description_category_id: 17027931, description_category_name: '净水与过滤',
    type_id: 94600, type_name: '野外过滤器',
    category_path_zh: ['运动与休闲', '野外过滤器'],
  };
  const categoryDecision: CategoryDecisionV1 = {
    schema_version: 1, source_offer_id: product.source.offer_id,
    product_understanding: {
      summary_zh: '户外便携净水器', product_family_zh: '净水器',
      evidence: [{ source: 'title_zh', value: product.product.title_zh }],
    },
    representative_sku_ids: [skuIds[0]!], product_structure: structure,
    category_groups: [{
      group_id: 'main', source_sku_ids: skuIds, group_summary_zh: '户外净水器',
      evidence: [{ source: 'title_zh', value: product.product.title_zh }],
      selected_category: selected, alternative_categories: [], confidence: 'high', rationale_zh: '匹配。',
    }],
    unassigned_sku_ids: [], status: 'decided', warnings: [], errors: [],
  };
  const schema: CategoryAttributesV1 = {
    schema_version: 1, source: 'ozon', language: 'ZH_HANS', ok: true,
    fetched_at: '2026-07-13T00:00:00.000Z', category: selected,
    attributes: [
      attribute(85, { required: true, dictionaryId: 1, values: [{ id: 126745801, value: '无品牌' }] }),
      attribute(4180), attribute(4191), attribute(4383, { type: 'Decimal' }),
      attribute(4389, { dictionaryId: 2, values: [{ id: 90296, value: '中国' }] }),
      attribute(4497, { type: 'Decimal' }),
      attribute(8229, { required: true, dictionaryId: 3, values: [{ id: 94600, value: '野外过滤器' }] }),
      attribute(8789), attribute(9024), attribute(9048, { required: true }),
      attribute(10096, { collection: true, dictionaryId: 4, values: [{ id: 369939085, value: '多色' }] }),
      attribute(11254), attribute(11650, { type: 'Integer' }), attribute(23171),
      attribute(23249, { type: 'Decimal' }),
    ],
    raw_response: {}, dictionary_raw_responses: {},
  };
  const categoryAttributeGroups: OzonDraftCategoryAttributesGroupV1[] = [
    { group_ids: ['main'], attributes_schema: schema },
  ];
  const agentInput: OzonDraftAgentInputV1 = {
    source_offer_id: product.source.offer_id,
    sku_inputs: skuIds.map((source_sku_id) => ({
      source_sku_id,
      name_ru: decision('Походный фильтр для воды'),
      description_ru: decision('Фильтр для очистки воды во время отдыха на природе.'),
      hashtags_ru: decision([...hashtags]),
      product_type: decision({ dictionary_value_id: 94600, value: '野外过滤器' }),
    })),
  };
  return { product, categoryDecision, categoryAttributeGroups, agentInput };
}

function decision<T>(value: T, confidence: 'high' | 'medium' | 'low' = 'high') {
  return { value, confidence, evidence };
}

function attribute(
  id: number,
  options: {
    type?: string; required?: boolean; dictionaryId?: number;
    collection?: boolean; values?: CategoryAttributeV1['values'];
  } = {},
): CategoryAttributeV1 {
  return {
    id, name: String(id), description: '', type: options.type ?? 'String',
    required: options.required ?? false, is_collection: options.collection ?? false,
    is_aspect: false, dictionary_id: options.dictionaryId ?? 0,
    group_id: 1, group_name: '基本属性', category_dependent: true,
    values: options.values ?? [],
  };
}

function valueOf(item: ReturnType<typeof buildOzonProductDraft>['draft']['items'][number], id: number) {
  return item.attributes.find((attribute) => attribute.id === id)?.values[0]?.value;
}

function dictionaryId(item: ReturnType<typeof buildOzonProductDraft>['draft']['items'][number], id: number) {
  return item.attributes.find((attribute) => attribute.id === id)?.values[0]?.dictionary_value_id;
}

function codes(result: ReturnType<typeof buildOzonProductDraft>): string[] {
  return result.validation.issues.map((entry) => entry.code);
}
