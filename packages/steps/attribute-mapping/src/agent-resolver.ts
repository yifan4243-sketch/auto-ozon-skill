import type {
  AttributeMappingAgentInputV1,
  CategoryAttributeV1,
  MappedOzonAttributeV1,
} from '@auto-ozon/contracts';
import { validateDictionaryValues } from './dictionary-resolver.js';

export interface AgentResolutionV1 {
  attribute: MappedOzonAttributeV1 | null;
  error: 'dictionary_value_not_found' | 'invalid_agent_value' | null;
}

export function resolveAgentAttribute(
  agentInput: AttributeMappingAgentInputV1 | undefined,
  sourceSkuId: string,
  attribute: CategoryAttributeV1,
  forbiddenTitleBrands: string[] = [],
): AgentResolutionV1 {
  const sku = agentInput?.sku_inputs.find((candidate) => candidate.source_sku_id === sourceSkuId);
  const selected = sku?.attributes.find((candidate) => candidate.attribute_id === attribute.id);
  if (!selected) return { attribute: null, error: null };
  if (!validateDictionaryValues(attribute, selected.values)) {
    return { attribute: null, error: 'dictionary_value_not_found' };
  }
  if (!validateAgentSemantics(attribute, selected.values, selected.evidence, forbiddenTitleBrands)) {
    return { attribute: null, error: 'invalid_agent_value' };
  }
  if (attribute.id === 4191 && !validContentClaims(selected.values[0]!.value, selected.content_claims)) {
    return { attribute: null, error: 'invalid_agent_value' };
  }
  return {
    attribute: {
      attribute_id: attribute.id,
      values: selected.values,
      provenance: 'agent_selected',
      confidence: attribute.id === 4383 ? 'low' : selected.confidence,
      evidence: selected.evidence,
      ...(attribute.id === 4191 ? { content_claims: selected.content_claims } : {}),
    },
    error: null,
  };
}

function validContentClaims(
  description: string,
  claims: AttributeMappingAgentInputV1['sku_inputs'][number]['attributes'][number]['content_claims'],
): boolean {
  const paragraphs = description.split(/\r?\n\s*\r?\n/u).map((value) => value.trim()).filter(Boolean);
  if (!claims || claims.length !== paragraphs.length) return false;
  return claims.every((claim, index) =>
    claim.claim_text.trim() === paragraphs[index]
    && claim.evidence.length > 0
    && claim.evidence.every((item) => item.source === 'canonical_v2' && item.field.trim() && item.value.trim()),
  );
}

function validateAgentSemantics(
  attribute: CategoryAttributeV1,
  values: AttributeMappingAgentInputV1['sku_inputs'][number]['attributes'][number]['values'],
  evidence: AttributeMappingAgentInputV1['sku_inputs'][number]['attributes'][number]['evidence'],
  forbiddenTitleBrands: string[],
): boolean {
  if (values.length === 0 || values.some((value) => !value.value.trim())) return false;
  const text = values.map((value) => value.value.trim()).join(' ');
  if (attribute.id === 4180) {
    const normalizedTitle = text.normalize('NFKC').toLocaleLowerCase();
    return /[А-Яа-яЁё]/u.test(text) &&
      !/(нет\s+бренда|без\s+бренда|no\s*name|无品牌)/iu.test(text) &&
      forbiddenTitleBrands.every((brand) => !normalizedTitle.includes(brand));
  }
  if (attribute.id === 4191) {
    const paragraphs = values[0]!.value
      .split(/\r?\n+/u)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean);
    return paragraphs.length >= 4 &&
      values[0]!.value.replace(/\s/gu, '').length >= 500 &&
      /[А-Яа-яЁё]/u.test(values[0]!.value);
  }
  if (attribute.id === 4383) {
    return values.length === 1 &&
      values[0]!.dictionary_value_id === undefined &&
      Number.isFinite(Number(values[0]!.value)) &&
      Number(values[0]!.value) > 3;
  }
  if (attribute.id === 23171) {
    const tags = values[0]!.value.trim().split(/\s+/u);
    return values.length === 1 && tags.length === 20 &&
      new Set(tags.map((tag) => tag.toLocaleLowerCase('ru-RU'))).size === 20 &&
      tags.every((tag) => /^#[\p{L}\p{N}_]+$/u.test(tag) && /[А-Яа-яЁё]/u.test(tag));
  }
  if (attribute.dictionary_id === 0 && ![4180, 4191, 4383, 23171].includes(attribute.id)) {
    return evidence.some((item) => item.source === 'canonical_v2');
  }
  return true;
}
