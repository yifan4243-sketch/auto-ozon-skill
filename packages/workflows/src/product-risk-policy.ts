import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CanonicalProductV2, CategoryDecisionV1 } from '@auto-ozon/contracts';

export type ProductRiskActionV1 = 'allow' | 'needs_review' | 'block';
export type ProductRiskSeverityV1 = 'low' | 'medium' | 'high' | 'critical';

export interface ProductRiskRuleV1 {
  rule_id: string;
  severity: ProductRiskSeverityV1;
  action: ProductRiskActionV1;
  keywords: { zh: string[]; ru: string[]; en: string[] };
  category_ids: number[];
  attribute_patterns: string[];
  exclusions: string[];
  message: string;
}

export interface ProductRiskPolicyV1 {
  schema_version: 1;
  policy_version: string;
  policy_scope: 'internal_conservative_sourcing_gate';
  rules: ProductRiskRuleV1[];
}

export interface ProductRiskFactV1 {
  field: string;
  value: string;
  kind: 'title' | 'source_category' | 'attribute' | 'ozon_category';
}

export interface ProductRiskMatchV1 {
  rule_id: string;
  severity: ProductRiskSeverityV1;
  matched_field: string;
  matched_value: string;
  evidence: string;
  policy_version: string;
  recommended_action: ProductRiskActionV1;
  suppressed: boolean;
  message: string;
}

export interface ProductRiskAssessmentV1 {
  schema_version: 1;
  policy_version: string;
  recommended_action: ProductRiskActionV1;
  matches: ProductRiskMatchV1[];
}

export interface ProductRiskInputV1 {
  facts: ProductRiskFactV1[];
  category_ids: number[];
}

let cachedPolicy: ProductRiskPolicyV1 | null = null;

export function loadProductRiskPolicy(): ProductRiskPolicyV1 {
  if (cachedPolicy) return cachedPolicy;
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const file = path.resolve(directory, '../references/product-risk-policy-v1.json');
  const value = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  cachedPolicy = assertPolicy(value);
  return cachedPolicy;
}

export function productRiskFacts(
  product: CanonicalProductV2,
  decision?: CategoryDecisionV1,
): ProductRiskInputV1 {
  const facts: ProductRiskFactV1[] = [
    { field: 'product.title_zh', value: product.product.title_zh, kind: 'title' },
    ...product.source.source_category_path_zh.map((value, index) => ({
      field: `source.source_category_path_zh[${index}]`, value, kind: 'source_category' as const,
    })),
    ...Object.entries(product.product.attributes).flatMap(([key, value]) => [
      { field: `product.attributes.${key}.name`, value: key, kind: 'attribute' as const },
      { field: `product.attributes.${key}.value`, value, kind: 'attribute' as const },
    ]),
  ];
  const categoryIds: number[] = [];
  for (const [index, group] of (decision?.category_groups ?? []).entries()) {
    const selected = group.selected_category;
    if (!selected) continue;
    categoryIds.push(selected.description_category_id, selected.type_id);
    facts.push(
      { field: `category_decision.category_groups[${index}].description_category_name`, value: selected.description_category_name, kind: 'ozon_category' },
      { field: `category_decision.category_groups[${index}].type_name`, value: selected.type_name, kind: 'ozon_category' },
      ...selected.category_path_zh.map((value, pathIndex) => ({
        field: `category_decision.category_groups[${index}].category_path_zh[${pathIndex}]`, value, kind: 'ozon_category' as const,
      })),
    );
  }
  return { facts, category_ids: [...new Set(categoryIds)] };
}

export function assessProductRisk(
  input: ProductRiskInputV1,
  policy: ProductRiskPolicyV1 = loadProductRiskPolicy(),
): ProductRiskAssessmentV1 {
  const matches = policy.rules.flatMap((rule) => evaluateRule(input, rule, policy.policy_version));
  const active = matches.filter((match) => !match.suppressed);
  const recommendedAction = active.some((match) => match.recommended_action === 'block')
    ? 'block'
    : active.some((match) => match.recommended_action === 'needs_review')
      ? 'needs_review'
      : 'allow';
  return {
    schema_version: 1,
    policy_version: policy.policy_version,
    recommended_action: recommendedAction,
    matches,
  };
}

function evaluateRule(input: ProductRiskInputV1, rule: ProductRiskRuleV1, policyVersion: string): ProductRiskMatchV1[] {
  const matches: ProductRiskMatchV1[] = [];
  const terms = [...rule.keywords.zh, ...rule.keywords.ru, ...rule.keywords.en];
  for (const fact of input.facts) {
    for (const term of terms) {
      if (!containsTerm(fact.value, term)) continue;
      const remaining = removeExcludedPhrases(fact.value, rule.exclusions);
      const suppressed = !containsTerm(remaining, term);
      matches.push(match(rule, policyVersion, fact.field, fact.value,
        suppressed ? `keyword:${term}; suppressed_by_context_exclusion` : `keyword:${term}`,
        suppressed ? 'allow' : rule.action, suppressed));
    }
    if (fact.kind === 'attribute') {
      for (const pattern of rule.attribute_patterns) {
        if (containsTerm(fact.value, pattern)) {
          matches.push(match(rule, policyVersion, fact.field, fact.value, `attribute_pattern:${pattern}`, rule.action, false));
        }
      }
    }
  }
  for (const categoryId of rule.category_ids) {
    if (input.category_ids.includes(categoryId)) {
      matches.push(match(rule, policyVersion, 'ozon.category_id', String(categoryId), `category_id:${categoryId}`, rule.action, false));
    }
  }
  return deduplicate(matches);
}

function match(
  rule: ProductRiskRuleV1,
  policyVersion: string,
  field: string,
  value: string,
  evidence: string,
  action: ProductRiskActionV1,
  suppressed: boolean,
): ProductRiskMatchV1 {
  return {
    rule_id: rule.rule_id,
    severity: rule.severity,
    matched_field: field,
    matched_value: value,
    evidence,
    policy_version: policyVersion,
    recommended_action: action,
    suppressed,
    message: rule.message,
  };
}

function containsTerm(value: string, term: string): boolean {
  const normalizedValue = normalize(value);
  const normalizedTerm = normalize(term);
  if (!normalizedTerm) return false;
  if (/\p{Script=Han}/u.test(normalizedTerm)) return normalizedValue.includes(normalizedTerm);
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegex(normalizedTerm)}(?:$|[^\\p{L}\\p{N}])`, 'iu').test(normalizedValue);
}

function removeExcludedPhrases(value: string, exclusions: string[]): string {
  let remaining = normalize(value);
  for (const exclusion of exclusions) {
    const normalized = normalize(exclusion);
    if (normalized) remaining = remaining.replaceAll(normalized, ' ');
  }
  return remaining;
}

function deduplicate(matches: ProductRiskMatchV1[]): ProductRiskMatchV1[] {
  const seen = new Set<string>();
  return matches.filter((entry) => {
    const key = `${entry.rule_id}\u0000${entry.matched_field}\u0000${entry.evidence}\u0000${entry.suppressed}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function assertPolicy(value: unknown): ProductRiskPolicyV1 {
  if (!isRecord(value) || value.schema_version !== 1
    || typeof value.policy_version !== 'string' || value.policy_scope !== 'internal_conservative_sourcing_gate'
    || !Array.isArray(value.rules) || value.rules.length === 0) throw new Error('PRODUCT_RISK_POLICY_INVALID');
  for (const raw of value.rules) {
    if (!isRecord(raw) || typeof raw.rule_id !== 'string' || typeof raw.message !== 'string'
      || !['low', 'medium', 'high', 'critical'].includes(String(raw.severity))
      || !['allow', 'needs_review', 'block'].includes(String(raw.action))
      || !isRecord(raw.keywords) || !stringArray(raw.keywords.zh) || !stringArray(raw.keywords.ru) || !stringArray(raw.keywords.en)
      || !numberArray(raw.category_ids) || !stringArray(raw.attribute_patterns) || !stringArray(raw.exclusions)) {
      throw new Error('PRODUCT_RISK_POLICY_INVALID');
    }
  }
  return value as unknown as ProductRiskPolicyV1;
}

function normalize(value: string): string { return value.normalize('NFKC').toLocaleLowerCase('und').trim(); }
function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }
function stringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.trim().length > 0); }
function numberArray(value: unknown): value is number[] { return Array.isArray(value) && value.every((entry) => Number.isSafeInteger(entry) && entry > 0); }
