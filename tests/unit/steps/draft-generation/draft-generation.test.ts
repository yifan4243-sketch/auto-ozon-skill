import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AttributeMappingV1,
  CategoryAttributesGroupV1,
  OzonDraftContentInputV1,
} from '../../../../packages/contracts/src/index.js';
import {
  FileArtifactStore,
  silentWorkflowLogger,
} from '../../../../packages/artifact-store/src/index.js';
import { runDraftGeneration } from '../../../../packages/steps/draft-generation/src/index.js';

const roots: string[] = [];
const evidence = [{
  source: 'agent_reasoning' as const,
  field: 'product.title_zh',
  value: '测试商品',
}];
const hashtags = Array.from({ length: 20 }, (_, index) => `#тест${index + 1}`);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('draft-generation step', () => {
  it('consumes AttributeMappingV1 and writes a separate draft artifact', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-ozon-draft-step-'));
    roots.push(root);
    const store = new FileArtifactStore({
      runsRoot: path.join(root, 'runs'),
      cacheRoot: path.join(root, 'cache'),
    });
    const result = await runDraftGeneration(
      fixture(),
      {
        run_id: 'draft-step-test',
        artifact_store: store,
        logger: silentWorkflowLogger,
        force_refresh: false,
      },
    );

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      status: 'completed',
      items: [{
        source_sku_id: 'sku-1',
        name: 'Тестовый товар',
        attributes: expect.arrayContaining([
          expect.objectContaining({ id: 85 }),
          expect.objectContaining({ id: 4180 }),
          expect.objectContaining({ id: 4191 }),
          expect.objectContaining({ id: 23171 }),
        ]),
      }],
    });
    await expect(
      store.exists('draft-step-test', 'draft-generation', 'product-draft-v1.json'),
    ).resolves.toBe(true);
    expect((await store.readManifest('draft-step-test'))?.steps['draft-generation'].status)
      .toBe('succeeded');
  });

  it('blocks missing copy without modifying the factual mapping', async () => {
    const input = fixture();
    input.content.sku_inputs = [];
    const before = structuredClone(input.attribute_mapping);
    const result = await runDraftGeneration(input);

    expect(result.ok).toBe(false);
    expect(result.data?.status).toBe('blocked');
    expect(result.errors.map((error) => error.code)).toContain('MISSING_COPY_INPUT');
    expect(input.attribute_mapping).toEqual(before);
  });
});

function fixture(): {
  attribute_mapping: AttributeMappingV1;
  category_attributes: CategoryAttributesGroupV1[];
  content: OzonDraftContentInputV1;
} {
  return {
    attribute_mapping: {
      schema_version: 1,
      source_offer_id: '900000000010',
      status: 'completed',
      common_attributes: [],
      variant_attributes: [],
      sku_attributes: [{
        source_sku_id: 'sku-1',
        group_id: 'main',
        description_category_id: 17027931,
        type_id: 94600,
        attributes: [{
          attribute_id: 85,
          values: [{ dictionary_value_id: 126745801, value: '无品牌' }],
          provenance: 'default',
          confidence: 'high',
          evidence: [{ source: 'policy', field: 'brand.default', value: '无品牌' }],
        }],
      }],
      missing_required_attributes: [],
      unresolved_attributes: [],
      warnings: [],
      errors: [],
    },
    category_attributes: [{
      group_ids: ['main'],
      category: {
        description_category_id: 17027931,
        description_category_name: '净水与过滤',
        type_id: 94600,
        type_name: '野外过滤器',
        category_path_zh: ['运动与休闲', '野外过滤器'],
      },
      attributes_schema: {
        schema_version: 1,
        source: 'ozon',
        language: 'ZH_HANS',
        ok: true,
        fetched_at: '2026-07-13T00:00:00.000Z',
        category: {
          description_category_id: 17027931,
          description_category_name: '净水与过滤',
          type_id: 94600,
          type_name: '野外过滤器',
          category_path_zh: ['运动与休闲', '野外过滤器'],
        },
        attributes: [85, 4180, 4191, 23171].map((id) => ({
          id,
          name: String(id),
          description: '',
          type: 'String',
          required: true,
          is_collection: false,
          is_aspect: false,
          dictionary_id: id === 85 ? 1 : 0,
          group_id: 1,
          group_name: '基本属性',
          category_dependent: true,
          values: id === 85 ? [{ id: 126745801, value: '无品牌', info: '' }] : [],
        })),
        raw_response: {},
        dictionary_raw_responses: {},
      },
    }],
    content: {
      source_offer_id: '900000000010',
      sku_inputs: [{
        source_sku_id: 'sku-1',
        name_ru: { value: 'Тестовый товар', confidence: 'high', evidence },
        description_ru: {
          value: 'Описание тестового товара на русском языке.',
          confidence: 'high',
          evidence,
        },
        hashtags_ru: { value: hashtags, confidence: 'high', evidence },
      }],
    },
  };
}
