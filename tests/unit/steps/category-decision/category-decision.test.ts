import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type {
  CanonicalProductV2,
  CategoryDecisionV1,
} from '../../../../packages/contracts/src/index.js';
import {
  flattenOzonCategoryTree,
  getOzonCategoryTreeStats,
  loadOzonCategoryIndex,
  loadOzonCategoryTree,
  searchOzonCategories,
  validateOzonCategoryPair,
  type OzonCategoryTreeDocument,
} from '../../../../packages/steps/category-decision/src/category-tree.js';
import { validateCategoryDecision } from '../../../../packages/steps/category-decision/src/validator.js';
import { validateCategoryDecisionSchema } from '../../../../packages/steps/category-decision/src/schema-validator.js';
import {
  runCategoryDecision,
  AgentDecisionProvider,
} from '../../../../packages/steps/category-decision/src/index.js';

const skillRoot = fileURLToPath(
  new URL(
    '../../../../packages/steps/category-decision/',
    import.meta.url,
  ),
);
const examples = [
  'single-sku',
  'normal-variants',
  'mixed-product',
] as const;

describe('Ozon category tree lookup', () => {
  it('reads the committed Chinese category tree without a derived copy', async () => {
    const tree = await loadOzonCategoryTree();
    const stats = getOzonCategoryTreeStats(tree);

    expect(stats).toEqual({
      root_count: 26,
      description_category_count: 568,
      type_count: 7424,
      disabled_description_category_count: 0,
      disabled_type_count: 0,
    });
  });

  it('returns stable lexical matches and an empty list for no match', async () => {
    const index = await loadOzonCategoryIndex();
    const first = searchOzonCategories(index, '智能手机壳', 5);
    const second = searchOzonCategories(index, '智能手机壳', 5);

    expect(first).toEqual(second);
    expect(first[0]).toMatchObject({
      description_category_id: 17028650,
      type_id: 97011,
      type_name: '智能手机壳',
      score: 100,
    });
    expect(searchOzonCategories(index, '绝对不存在的类目词', 10)).toEqual([]);
  });

  it('requires the description-category and type pair for repeated type IDs', async () => {
    const index = await loadOzonCategoryIndex();
    const repeated = index.filter((entry) => entry.type_id === 91260);

    expect(repeated).toHaveLength(2);
    expect(validateOzonCategoryPair(index, 15621049, 91260).valid).toBe(true);
    expect(validateOzonCategoryPair(index, 15621048, 91260).valid).toBe(true);
    expect(validateOzonCategoryPair(index, 17028650, 91260)).toMatchObject({
      valid: false,
      code: 'CATEGORY_PAIR_NOT_FOUND',
    });
  });

  it('propagates disabled category state and rejects the pair', () => {
    const tree: OzonCategoryTreeDocument = {
      result: [
        {
          description_category_id: 10,
          category_name: '测试分类',
          disabled: true,
          children: [
            { type_id: 20, type_name: '测试类型', disabled: false, children: [] },
          ],
        },
      ],
    };
    const index = flattenOzonCategoryTree(tree);

    expect(index[0]?.disabled).toBe(true);
    expect(searchOzonCategories(index, '测试类型')).toEqual([]);
    expect(validateOzonCategoryPair(index, 10, 20)).toMatchObject({
      valid: false,
      code: 'CATEGORY_DISABLED',
    });
  });
});

describe('CategoryDecisionV1 examples and validation', () => {
  for (const name of examples) {
    it(`${name} matches the JSON schema and passes semantic validation`, async () => {
      const input = readJson(`examples/${name}.input.json`) as CanonicalProductV2;
      const output = readJson(`examples/${name}.output.json`) as CategoryDecisionV1;
      const index = await loadOzonCategoryIndex();

      expect(validateCategoryDecisionSchema(output)).toEqual({
        valid: true,
        errors: [],
      });
      expect(validateCategoryDecision(output, input, index)).toEqual({
        status: 'pass',
        valid: true,
        violations: [],
      });
    });
  }

  it('detects missing and duplicate SKU coverage', async () => {
    const input = readJson('examples/normal-variants.input.json') as CanonicalProductV2;
    const output = readJson('examples/normal-variants.output.json') as CategoryDecisionV1;
    const index = await loadOzonCategoryIndex();
    output.category_groups[0]!.source_sku_ids = ['shirt-black-m'];
    output.category_groups.push({
      ...structuredClone(output.category_groups[0]!),
      group_id: 'duplicate',
      source_sku_ids: ['shirt-black-m'],
    });

    const codes = validateCategoryDecision(output, input, index).violations.map(
      (violation) => violation.code,
    );
    expect(codes).toContain('DUPLICATE_SKU_ASSIGNMENT');
    expect(codes).toContain('MISSING_SKU_COVERAGE');
  });

  it('requires blocked status for blocked input and unassigned SKUs', async () => {
    const input = readJson('examples/single-sku.input.json') as CanonicalProductV2;
    const output = readJson('examples/single-sku.output.json') as CategoryDecisionV1;
    const index = await loadOzonCategoryIndex();
    input.validation.status = 'blocked';
    output.category_groups = [];
    output.unassigned_sku_ids = ['case-default'];
    output.status = 'needs_review';

    const codes = validateCategoryDecision(output, input, index).violations.map(
      (violation) => violation.code,
    );
    expect(codes).toContain('BLOCKED_SOURCE_PRODUCT');
    expect(codes).toContain('UNASSIGNED_SKUS_REQUIRE_BLOCKED');
  });

  it('exposes one service entry for provider-driven decisions', async () => {
    const input = readJson('examples/mixed-product.input.json') as CanonicalProductV2;
    const output = readJson('examples/mixed-product.output.json') as CategoryDecisionV1;
    const result = await runCategoryDecision({
      product: input,
      provider: new AgentDecisionProvider(async () => structuredClone(output)),
    });

    expect(result.ok).toBe(true);
    expect(result.command).toBe('category.decision');
    expect(result.data).toEqual(output);
  });

  it('blocks invalid provider output at the public service boundary', async () => {
    const input = readJson('examples/normal-variants.input.json') as CanonicalProductV2;
    const output = readJson('examples/normal-variants.output.json') as CategoryDecisionV1;
    output.category_groups[0]!.selected_category!.type_id = 1;

    const result = await runCategoryDecision({
      product: input,
      provider: new AgentDecisionProvider(async () => output),
    });

    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe('CATEGORY_DECISION_VALIDATION_FAILED');
  });
});

function readJson(relativePath: string): unknown {
  return JSON.parse(fs.readFileSync(`${skillRoot}${relativePath}`, 'utf8')) as unknown;
}
