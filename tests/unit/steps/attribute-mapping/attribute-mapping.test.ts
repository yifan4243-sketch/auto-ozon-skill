import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AttributeMappingAgentInputV1,
  CanonicalProductV2,
  CategoryAttributesGroupV1,
  CategoryDecisionV1,
} from '../../../../packages/contracts/src/index.js';
import {
  FileArtifactStore,
  silentWorkflowLogger,
} from '../../../../packages/artifact-store/src/index.js';
import { runAttributeMapping } from '../../../../packages/steps/attribute-mapping/src/index.js';
import {
  normalizedNetWeightGrams,
  parseWeightTextToGrams,
} from '../../../../packages/steps/attribute-mapping/src/unit-normalizer.js';
import { formatRunTimestamp } from '../../../../packages/steps/attribute-mapping/src/deterministic-matcher.js';
import { validateAttributeMappingSchema } from '../../../../packages/steps/attribute-mapping/src/schema-validator.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('runAttributeMapping', () => {
  it('keeps the documented common-and-variant example schema-valid', async () => {
    const example = JSON.parse(await fs.readFile(
      new URL('../../../../packages/steps/attribute-mapping/examples/common-and-variant.output.json', import.meta.url),
      'utf8',
    ));
    expect(validateAttributeMappingSchema(example)).toEqual({ valid: true, errors: [] });
    expect(example.common_attributes.length).toBeGreaterThan(0);
    expect(example.variant_attributes.length).toBeGreaterThan(0);
    expect(example.sku_attributes.length).toBeGreaterThan(1);
  });

  it('produces common, variant, and complete per-SKU attributes', async () => {
    const fixture = inputFixture();
    const result = await runAttributeMapping(fixture);

    expect(result.ok).toBe(true);
    expect(result.data?.status).toBe('completed');
    expect(result.data?.sku_attributes).toHaveLength(2);
    expect(result.data?.common_attributes.map((entry) => entry.attribute.attribute_id)).toEqual(
      expect.arrayContaining([85, 4389, 8229, 9048, 11650, 23249]),
    );
    expect(result.data?.variant_attributes.map((entry) => entry.attribute_id)).toEqual(
      expect.arrayContaining([10096, 4383]),
    );
    expect(result.data?.sku_attributes[0]?.attributes.some((attribute) => attribute.attribute_id === 4497)).toBe(false);
    expect(result.data?.sku_attributes[0]?.attributes.some((attribute) => attribute.attribute_id === 500)).toBe(false);
    expect(result.data?.sku_attributes[0]?.ozon_attributes.map((attribute) => attribute.id)).toEqual(
      [...(result.data?.sku_attributes[0]?.ozon_attributes.map((attribute) => attribute.id) ?? [])]
        .sort((a, b) => a - b),
    );
    expect(result.data?.agent_tasks).toEqual([]);
    expect(result.data?.missing_required_attributes).toEqual([]);
    expect(validateAttributeMappingSchema(result.data)).toEqual({ valid: true, errors: [] });
  });

  it('blocks missing required attributes', async () => {
    const fixture = inputFixture();
    fixture.agent_input = undefined;
    const result = await runAttributeMapping(fixture);

    expect(result.ok).toBe(false);
    expect(result.data?.status).toBe('blocked');
    expect(result.data?.missing_required_attributes).toEqual(expect.arrayContaining([
      expect.objectContaining({ attribute_id: 4180, source_sku_ids: ['red'] }),
      expect.objectContaining({ attribute_id: 8229, source_sku_ids: ['red'] }),
      expect.objectContaining({ attribute_id: 23171, source_sku_ids: ['blue'] }),
    ]));
    expect(result.data?.agent_tasks.length).toBeGreaterThan(0);
    expect(result.errors.map((error) => error.code)).toContain('MISSING_REQUIRED_ATTRIBUTES');
    expect(validateAttributeMappingSchema(result.data).valid).toBe(true);
  });

  it('rejects Agent dictionary IDs that are absent from the current snapshot', async () => {
    const fixture = inputFixture();
    const selected = fixture.agent_input!.sku_inputs[0]!.attributes.find(
      (attribute) => attribute.attribute_id === 8229,
    )!;
    selected.values[0] = {
      dictionary_value_id: 999,
      value: '不存在',
    };
    const result = await runAttributeMapping(fixture);

    expect(result.ok).toBe(false);
    expect(result.data?.unresolved_attributes).toContainEqual(
      expect.objectContaining({
        attribute_id: 8229,
        source_sku_ids: ['red'],
        reason: 'dictionary_value_not_found',
      }),
    );
  });

  it('marks low-confidence Agent selections for review', async () => {
    const fixture = inputFixture();
    fixture.agent_input!.sku_inputs[0]!.attributes.find(
      (attribute) => attribute.attribute_id === 8229,
    )!.confidence = 'low';
    const result = await runAttributeMapping(fixture);

    expect(result.ok).toBe(true);
    expect(result.data?.status).toBe('needs_review');
    expect(result.warnings.map((warning) => warning.code)).toContain('LOW_CONFIDENCE_ATTRIBUTE');
  });

  it('writes the mapping into the unified run directory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-ozon-mapping-'));
    temporaryDirectories.push(root);
    const store = new FileArtifactStore({
      repoRoot: root,
      runsRoot: path.join(root, 'runs'),
      cacheRoot: path.join(root, 'cache'),
    });
    const result = await runAttributeMapping(inputFixture(), {
      run_id: 'mapping-run',
      artifact_store: store,
      logger: silentWorkflowLogger,
      force_refresh: false,
    });

    expect(result.ok).toBe(true);
    expect(await store.exists(
      'mapping-run',
      'attribute-mapping',
      'attribute-mapping-v1.json',
    )).toBe(true);
    expect((await store.readManifest('mapping-run'))?.steps['attribute-mapping']).toMatchObject({
      status: 'succeeded',
      output: '05-attribute-mapping/attribute-mapping-v1.json',
    });
  });

  it('normalizes explicit source units and rejects weights at or below three grams', () => {
    expect(parseWeightTextToGrams('0.25 KG')).toBe(250);
    expect(parseWeightTextToGrams('125克')).toBe(125);
    expect(parseWeightTextToGrams('3 g')).toBeNull();
    expect(parseWeightTextToGrams('100')).toBeNull();
    expect(normalizedNetWeightGrams(sku('kg', '白色', 1, 'kg'))).toBe(1000);
    expect(normalizedNetWeightGrams(sku('tiny', '白色', 3))).toBeNull();
  });

  it('formats one stable Beijing run timestamp to the second', () => {
    expect(formatRunTimestamp('2026-07-10T14:33:44.000Z')).toBe('20260710223344');
  });

  it('accepts an Agent weight estimate over three grams without needs_review', async () => {
    const fixture = inputFixture();
    fixture.product.skus[0]!.package.raw_weight = null;
    fixture.product.skus[0]!.package.weight_unit = 'unknown';
    delete fixture.product.product.attributes.净重说明;
    fixture.agent_input!.sku_inputs[0]!.attributes.push({
      attribute_id: 4383,
      values: [{ value: '180' }],
      confidence: 'high',
      evidence: [{ source: 'agent_input', field: 'estimated weight', value: '180g' }],
    });
    const result = await runAttributeMapping(fixture);
    const weight = result.data?.sku_attributes[0]?.attributes.find(
      (attribute) => attribute.attribute_id === 4383,
    );
    expect(result.ok).toBe(true);
    expect(result.data?.status).toBe('completed');
    expect(weight).toMatchObject({ provenance: 'agent_selected', confidence: 'low' });
  });

  it('rejects short descriptions and malformed hashtag sets', async () => {
    const fixture = inputFixture();
    const attributes = fixture.agent_input!.sku_inputs[0]!.attributes;
    attributes.find((attribute) => attribute.attribute_id === 4191)!.values = [{ value: 'Коротко' }];
    attributes.find((attribute) => attribute.attribute_id === 23171)!.values = [{ value: '#один #два' }];
    const result = await runAttributeMapping(fixture);
    expect(result.ok).toBe(false);
    expect(result.data?.unresolved_attributes).toEqual(expect.arrayContaining([
      expect.objectContaining({ attribute_id: 4191, reason: 'invalid_agent_value' }),
      expect.objectContaining({ attribute_id: 23171, reason: 'invalid_agent_value' }),
    ]));
  });

  it('rejects a real source brand in the Agent title while attribute 85 stays no-brand', async () => {
    const fixture = inputFixture();
    fixture.product.product.attributes.品牌 = 'ExampleBrand';
    fixture.agent_input!.sku_inputs[0]!.attributes.find(
      (attribute) => attribute.attribute_id === 4180,
    )!.values = [{ value: 'Чашка ExampleBrand красная' }];
    const result = await runAttributeMapping(fixture);
    expect(result.ok).toBe(false);
    expect(result.data?.unresolved_attributes).toContainEqual(
      expect.objectContaining({ attribute_id: 4180, reason: 'invalid_agent_value' }),
    );
  });

  it('routes an unlisted required attribute to the Agent instead of filling optional facts', async () => {
    const fixture = inputFixture();
    fixture.category_attributes[0]!.attributes_schema.attributes.find(
      (attribute) => attribute.id === 500,
    )!.required = true;
    const result = await runAttributeMapping(fixture);
    expect(result.ok).toBe(false);
    expect(result.data?.agent_tasks).toContainEqual(
      expect.objectContaining({ attribute_id: 500, required: true }),
    );
  });
});

function inputFixture(): {
  product: CanonicalProductV2;
  category_decision: CategoryDecisionV1;
  category_attributes: CategoryAttributesGroupV1[];
  agent_input?: AttributeMappingAgentInputV1;
} {
  const product: CanonicalProductV2 = {
    schema_version: 2,
    source: {
      platform: '1688',
      offer_id: '123456789',
      offer_url: 'https://detail.1688.com/offer/123456789.html',
      collected_at: '2026-07-13T00:00:00.000Z',
      collection_method: 'offers',
      detail_url: null,
      source_category_path_zh: ['家居', '餐具'],
      discovery_context: { search_term: null, seed_offer_id: null },
    },
    product: {
      title_zh: '陶瓷杯',
      main_image: null,
      gallery_images: [],
      attributes: { 材质: '陶瓷', 净重说明: '200克' },
      price_tiers: [],
      sku_options: [],
    },
    skus: [
      sku('red', '红色', 200),
      sku('blue', '蓝色', 250),
    ],
    sku_analysis: {
      has_source_skus: true,
      is_multi_sku: true,
      sku_count: 2,
      common_fields: {},
      varying_fields: [],
      variant_dimensions: [],
      missing_fields: [],
      duplicate_spec_combinations: [],
      warnings: [],
    },
    validation: { status: 'valid', warnings: [], errors: [] },
  };
  const selected = {
    description_category_id: 17028741,
    description_category_name: '餐具',
    type_id: 92537,
    type_name: '茶具',
    category_path_zh: ['家居', '餐具', '茶具'],
  };
  const category_decision: CategoryDecisionV1 = {
    schema_version: 1,
    source_offer_id: product.source.offer_id,
    product_understanding: { summary_zh: '陶瓷杯', product_family_zh: '杯具', evidence: [] },
    representative_sku_ids: ['red'],
    product_structure: 'normal_variants',
    category_groups: [{
      group_id: 'cups',
      source_sku_ids: ['red', 'blue'],
      group_summary_zh: '陶瓷杯颜色变体',
      evidence: [],
      selected_category: selected,
      alternative_categories: [],
      confidence: 'high',
      rationale_zh: '功能相同，仅颜色不同',
    }],
    unassigned_sku_ids: [],
    status: 'decided',
    warnings: [],
    errors: [],
  };
  const category_attributes: CategoryAttributesGroupV1[] = [{
    group_ids: ['cups'],
    category: selected,
    attributes_schema: {
      schema_version: 1,
      source: 'ozon',
      language: 'ZH_HANS',
      ok: true,
      fetched_at: '2026-07-13T00:00:00.000Z',
      category: {
        description_category_id: selected.description_category_id,
        type_id: selected.type_id,
      },
      attributes: [
        attribute(85, '品牌', true, 28732849, []),
        attribute(4180, '名称', false, 0, []),
        attribute(4191, '简介', false, 0, []),
        attribute(500, '材质', false, 0, []),
        attribute(10096, '颜色', true, 10, [
          { id: 1, value: '红色' },
          { id: 2, value: '蓝色' },
          { id: 3, value: '多色' },
        ]),
        attribute(4383, '净重', true, 0, []),
        attribute(4389, '原产国', false, 1935, [{ id: 90296, value: '中国' }]),
        attribute(4497, '包装重量', false, 0, []),
        attribute(9048, '型号名称', true, 0, []),
        attribute(11650, '原厂包装数量', false, 0, []),
        attribute(8229, '商品类型', true, 20, [{ id: 30, value: '茶杯' }]),
        attribute(23171, '#主题标签', false, 0, []),
        attribute(23249, '统一计量单位中的商品数量', false, 0, []),
      ],
      raw_response: {},
      dictionary_raw_responses: {},
    },
  }];
  const agent_input: AttributeMappingAgentInputV1 = {
    source_offer_id: product.source.offer_id,
    sku_inputs: ['red', 'blue'].map((sourceSkuId) => ({
      source_sku_id: sourceSkuId,
      attributes: agentAttributes(sourceSkuId),
    })),
  };
  return {
    product,
    category_decision,
    category_attributes,
    agent_input,
    run_created_at: '2026-07-10T14:33:44.000Z',
  };
}

function sku(sourceSkuId: string, color: string, weight: number, unit: 'g' | 'kg' = 'g') {
  return {
    source_sku_id: sourceSkuId,
    raw_spec_text: color,
    specs: { 颜色: color },
    unparsed_spec_segments: [],
    price_cny: 10,
    multi_price_cny: null,
    image: null,
    package: {
      length_cm: 10,
      width_cm: 10,
      height_cm: 10,
      raw_weight: weight,
      weight_unit: unit,
      source: '1688' as const,
      matched_by: 'sku_id' as const,
    },
  };
}

function agentAttributes(sourceSkuId: string): AttributeMappingAgentInputV1['sku_inputs'][number]['attributes'] {
  const color = sourceSkuId === 'red'
    ? { dictionary_value_id: 1, value: '红色' }
    : { dictionary_value_id: 2, value: '蓝色' };
  const descriptionParagraph = 'Керамическая чашка предназначена для ежедневного использования дома и в офисе. Форма изделия удобна для горячих и прохладных напитков, а характеристики основаны на данных поставщика. ';
  const description = Array.from({ length: 4 }, () => descriptionParagraph).join('\n');
  const hashtags = Array.from({ length: 20 }, (_, index) => `#чашка_${index + 1}`).join(' ');
  const evidence = [{ source: 'agent_input' as const, field: 'retained 1688 facts', value: sourceSkuId }];
  return [
    { attribute_id: 4180, values: [{ value: `Чашка керамическая ${sourceSkuId === 'red' ? 'красная' : 'синяя'}` }], confidence: 'high', evidence },
    { attribute_id: 4191, values: [{ value: description }], confidence: 'high', evidence },
    { attribute_id: 8229, values: [{ dictionary_value_id: 30, value: '茶杯' }], confidence: 'high', evidence },
    { attribute_id: 10096, values: [color], confidence: 'high', evidence },
    { attribute_id: 23171, values: [{ value: hashtags }], confidence: 'high', evidence },
  ];
}

function attribute(
  id: number,
  name: string,
  required: boolean,
  dictionaryId: number,
  values: Array<{ id: number; value: string }>,
) {
  return {
    id,
    name,
    description: '',
    type: 'String',
    required,
    is_collection: false,
    is_aspect: false,
    dictionary_id: dictionaryId,
    group_id: 1,
    group_name: '基本属性',
    category_dependent: true,
    values,
  };
}
