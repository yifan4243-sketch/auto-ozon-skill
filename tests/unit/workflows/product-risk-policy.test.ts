import { describe, expect, it } from 'vitest';
import {
  assessProductRisk,
  loadProductRiskPolicy,
  type ProductRiskPolicyV1,
} from '../../../packages/workflows/src/product-risk-policy.js';

describe('versioned product risk policy', () => {
  it('loads a versioned, structured policy', () => {
    const policy = loadProductRiskPolicy();
    expect(policy).toMatchObject({
      schema_version: 1,
      policy_version: 'product-risk-policy-v1-2026-07',
      policy_scope: 'internal_conservative_sourcing_gate',
    });
    expect(policy.rules.length).toBeGreaterThan(0);
    expect(policy.rules.every((rule) => ['allow', 'needs_review', 'block'].includes(rule.action))).toBe(true);
  });

  it('routes Chinese battery facts to review and records audit evidence', () => {
    const result = assessProductRisk(input('商品内置锂电池', 'product.title_zh'));
    expect(result.recommended_action).toBe('needs_review');
    expect(result.matches).toEqual(expect.arrayContaining([
      expect.objectContaining({
        rule_id: 'batteries',
        matched_field: 'product.title_zh',
        matched_value: '商品内置锂电池',
        evidence: expect.stringContaining('keyword:'),
        policy_version: result.policy_version,
        recommended_action: 'needs_review',
        suppressed: false,
      }),
    ]));
  });

  it('does not block a battery storage box false positive but preserves the suppressed match', () => {
    const result = assessProductRisk(input('家用电池收纳盒', 'product.title_zh'));
    expect(result.recommended_action).toBe('allow');
    expect(result.matches).toEqual(expect.arrayContaining([
      expect.objectContaining({
        rule_id: 'batteries',
        recommended_action: 'allow',
        suppressed: true,
        evidence: expect.stringContaining('suppressed_by_context_exclusion'),
      }),
    ]));
  });

  it('still reviews a real battery signal outside an excluded storage-box phrase', () => {
    const result = assessProductRisk(input('电池收纳盒，附带一节锂电池', 'product.title_zh'));
    expect(result.recommended_action).toBe('needs_review');
    expect(result.matches.some((entry) => entry.rule_id === 'batteries' && !entry.suppressed)).toBe(true);
  });

  it.each([
    ['ru', 'Портативное устройство с литиевой батареей'],
    ['en', 'Portable light with rechargeable battery'],
  ])('matches %s risk synonyms', (_language, value) => {
    const result = assessProductRisk(input(value, 'product.title'));
    expect(result.recommended_action).toBe('needs_review');
    expect(result.matches.some((entry) => entry.rule_id === 'batteries' && !entry.suppressed)).toBe(true);
  });

  it('blocks an explicit prohibited weapon term instead of treating every risk as review', () => {
    const result = assessProductRisk(input('Комплект боеприпасов', 'product.title'));
    expect(result.recommended_action).toBe('block');
    expect(result.matches).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule_id: 'weapons-and-explosives', recommended_action: 'block' }),
    ]));
  });

  it('matches configured category IDs without inventing IDs in the repository policy', () => {
    const policy: ProductRiskPolicyV1 = {
      schema_version: 1,
      policy_version: 'test-policy-v1',
      policy_scope: 'internal_conservative_sourcing_gate',
      rules: [{
        rule_id: 'fixture-category', severity: 'high', action: 'needs_review',
        keywords: { zh: [], ru: [], en: [] }, category_ids: [92417201],
        attribute_patterns: [], exclusions: [], message: 'Fixture category review.',
      }],
    };
    const result = assessProductRisk({ facts: [], category_ids: [92417201] }, policy);
    expect(result).toMatchObject({ recommended_action: 'needs_review' });
    expect(result.matches[0]).toMatchObject({
      rule_id: 'fixture-category',
      matched_field: 'ozon.category_id',
      matched_value: '92417201',
      evidence: 'category_id:92417201',
      policy_version: 'test-policy-v1',
    });
  });

  it('matches an attribute-pattern signal separately from title keywords', () => {
    const result = assessProductRisk({
      facts: [{ field: 'product.attributes.电池类型.name', value: '电池类型', kind: 'attribute' }],
      category_ids: [],
    });
    expect(result.recommended_action).toBe('needs_review');
    expect(result.matches).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule_id: 'batteries', evidence: 'attribute_pattern:电池类型' }),
    ]));
  });
});

function input(value: string, field: string) {
  return { facts: [{ field, value, kind: 'title' as const }], category_ids: [] };
}
