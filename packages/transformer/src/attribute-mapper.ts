import type {
  CanonicalProductV2,
  CanonicalSkuV2,
  CanonicalWeightUnitV2,
} from '../../contracts/src/canonical-product-v2.js';
import type { CategoryAttributeV1 } from '../../contracts/src/category-attributes.js';
import type { CategoryDecisionV1 } from '../../contracts/src/category-decision.js';
import type {
  OzonDraftAgentInputV1,
  OzonDraftAgentSkuInputV1,
  OzonDraftAgentValueV1,
  OzonDraftAttributeV1,
  OzonDraftCategoryAttributesGroupV1,
  OzonDraftConfidenceV1,
  OzonDraftDictionaryValueV1,
  OzonDraftEvidenceV1,
  OzonDraftIssueV1,
  OzonDraftProvenanceV1,
  OzonDraftSkuV1,
  OzonDraftValidationV1,
  OzonProductDraftV1,
} from '../../contracts/src/ozon-product-draft.js';
import {
  getOzonDraftAttributeRule,
  OZON_DRAFT_ATTRIBUTE_IDS as A,
  OZON_DRAFT_DEFAULT_DICTIONARY_IDS as DEFAULTS,
} from './validation/category-attribute-rules.js';

export interface BuildOzonDraftInputV1 {
  product: CanonicalProductV2;
  categoryDecision: CategoryDecisionV1;
  categoryAttributeGroups: OzonDraftCategoryAttributesGroupV1[];
  agentInput: OzonDraftAgentInputV1;
}

export interface BuildOzonDraftResultV1 {
  draft: OzonProductDraftV1;
  validation: OzonDraftValidationV1;
}

export interface NormalizedDraftWeightV1 {
  grams: number;
  provenance: 'source' | 'converted' | 'agent_estimated';
  confidence: OzonDraftConfidenceV1;
  evidence: OzonDraftEvidenceV1[];
}

export function normalizeDraftNetWeight(
  rawWeight: number | null,
  unit: CanonicalWeightUnitV2,
  estimate?: OzonDraftAgentValueV1<number>,
): NormalizedDraftWeightV1 | null {
  if (positive(rawWeight) && (unit === 'g' || unit === 'kg')) {
    return {
      grams: decimal(unit === 'kg' ? rawWeight * 1000 : rawWeight),
      provenance: unit === 'kg' ? 'converted' : 'source',
      confidence: 'high',
      evidence: [{
        source: 'canonical_v2',
        field: 'sku.package.raw_weight',
        value: `${rawWeight} ${unit}`,
      }],
    };
  }
  if (estimate && positive(estimate.value)) {
    return {
      grams: decimal(estimate.value),
      provenance: 'agent_estimated',
      confidence: estimate.confidence,
      evidence: estimate.evidence,
    };
  }
  return null;
}

export function buildOzonProductDraft(input: BuildOzonDraftInputV1): BuildOzonDraftResultV1 {
  const { product, categoryDecision, categoryAttributeGroups, agentInput } = input;
  const issues: OzonDraftValidationV1['issues'] = [];
  const items: OzonDraftSkuV1[] = [];
  const sourceSkus = uniqueMap(
    product.skus,
    (sku) => sku.source_sku_id,
    (skuId) => issue('error', 'DUPLICATE_SOURCE_SKU', 'CanonicalProductV2 contains the SKU twice.', [skuId]),
  );
  const agentSkus = uniqueMap(
    agentInput.sku_inputs,
    (sku) => sku.source_sku_id,
    (skuId) => issue('error', 'DUPLICATE_AGENT_SKU_INPUT', 'Agent supplied the SKU twice.', [skuId]),
  );
  const assignments = new Map<string, number>();

  if (product.source.offer_id !== categoryDecision.source_offer_id) {
    issue('error', 'CATEGORY_DECISION_OFFER_ID_MISMATCH', 'Category decision belongs to another offer.');
  }
  if (product.source.offer_id !== agentInput.source_offer_id) {
    issue('error', 'AGENT_INPUT_OFFER_ID_MISMATCH', 'Agent input belongs to another offer.');
  }
  if (product.validation.status === 'blocked') {
    issue('error', 'BLOCKED_SOURCE_PRODUCT', 'A blocked source product cannot produce a draft.');
  } else if (product.validation.status !== 'valid') {
    issue('warning', 'SOURCE_PRODUCT_REQUIRES_REVIEW', 'Source product requires review.');
  }
  if (categoryDecision.status === 'blocked') {
    issue('error', 'BLOCKED_CATEGORY_DECISION', 'A blocked category decision cannot produce a draft.');
  } else if (categoryDecision.status === 'needs_review') {
    issue('warning', 'CATEGORY_DECISION_REQUIRES_REVIEW', 'Category decision requires review.');
  }
  if (categoryDecision.unassigned_sku_ids.length > 0) {
    issue('error', 'UNASSIGNED_CATEGORY_SKU', 'Category decision leaves SKUs unassigned.', categoryDecision.unassigned_sku_ids);
  }

  for (const group of categoryDecision.category_groups) {
    const selected = group.selected_category;
    if (!selected) {
      issue('error', 'CATEGORY_GROUP_WITHOUT_SELECTION', `Group ${group.group_id} has no category.`, group.source_sku_ids);
      continue;
    }
    const snapshots = categoryAttributeGroups.filter((candidate) =>
      candidate.group_ids.includes(group.group_id),
    );
    if (snapshots.length !== 1) {
      issue('error', 'CATEGORY_ATTRIBUTES_GROUP_MISMATCH', `Group ${group.group_id} needs exactly one attribute snapshot.`, group.source_sku_ids);
      continue;
    }
    const schema = snapshots[0]!.attributes_schema;
    if (
      !schema.ok ||
      schema.category.description_category_id !== selected.description_category_id ||
      schema.category.type_id !== selected.type_id
    ) {
      issue('error', 'CATEGORY_ATTRIBUTES_PAIR_MISMATCH', `Group ${group.group_id} has a mismatched attribute snapshot.`, group.source_sku_ids);
      continue;
    }

    for (const skuId of group.source_sku_ids) {
      const count = (assignments.get(skuId) ?? 0) + 1;
      assignments.set(skuId, count);
      if (count > 1) {
        issue('error', 'DUPLICATE_SKU_ASSIGNMENT', 'SKU is assigned to more than one group.', [skuId]);
        continue;
      }
      const sourceSku = sourceSkus.get(skuId);
      const agentSku = agentSkus.get(skuId);
      if (!sourceSku) {
        issue('error', 'UNKNOWN_CATEGORY_SKU', 'Category decision references an unknown SKU.', [skuId]);
      } else if (!agentSku) {
        issue('error', 'MISSING_AGENT_SKU_INPUT', 'Agent did not prepare this SKU.', [skuId]);
      } else {
        items.push(mapSku(sourceSku, agentSku, group.group_id, selected, schema.attributes));
      }
    }
  }

  for (const skuId of sourceSkus.keys()) {
    if (!assignments.has(skuId)) {
      issue('error', 'MISSING_CATEGORY_SKU_COVERAGE', 'Source SKU is not assigned to a category group.', [skuId]);
    }
  }
  for (const skuId of agentSkus.keys()) {
    if (!sourceSkus.has(skuId)) {
      issue('error', 'UNKNOWN_AGENT_SKU_INPUT', 'Agent input references an unknown SKU.', [skuId]);
    }
  }

  const status = issues.some((entry) => entry.severity === 'error')
    ? 'blocked'
    : issues.length > 0
      ? 'needs_review'
      : 'completed';
  const strip = ({ severity: _severity, ...entry }: OzonDraftValidationV1['issues'][number]): OzonDraftIssueV1 => entry;
  const draft: OzonProductDraftV1 = {
    schema_version: 1,
    source_offer_id: product.source.offer_id,
    status,
    items,
    warnings: issues.filter((entry) => entry.severity === 'warning').map(strip),
    errors: issues.filter((entry) => entry.severity === 'error').map(strip),
  };
  return {
    draft,
    validation: {
      schema_version: 1,
      source_offer_id: product.source.offer_id,
      status,
      valid: status !== 'blocked',
      issues,
    },
  };

  function mapSku(
    sourceSku: CanonicalSkuV2,
    agentSku: OzonDraftAgentSkuInputV1,
    groupId: string,
    selected: NonNullable<CategoryDecisionV1['category_groups'][number]['selected_category']>,
    definitionsList: CategoryAttributeV1[],
  ): OzonDraftSkuV1 {
    const definitions = new Map(definitionsList.map((definition) => [definition.id, definition]));
    const attributes = new Map<number, OzonDraftAttributeV1>();
    const skuId = sourceSku.source_sku_id;
    const policy = (field: string, value: string): OzonDraftEvidenceV1[] => [
      { source: 'policy', field, value },
    ];
    const fixed = (
      dictionaryValueId: number,
      label: string,
      field: string,
    ): OzonDraftAgentValueV1<OzonDraftDictionaryValueV1> => ({
      value: { dictionary_value_id: dictionaryValueId, value: label },
      confidence: 'high',
      evidence: policy(field, label),
    });

    addDictionary(
      A.brand,
      agentSku.brand ?? fixed(DEFAULTS.noBrand, '无品牌', 'attribute.85.default'),
      agentSku.brand ? 'source' : 'default',
    );
    addText(A.name, agentSku.name_ru, 'derived');
    addText(A.description, agentSku.description_ru, 'derived');

    const weight = normalizeDraftNetWeight(
      sourceSku.package.raw_weight,
      sourceSku.package.weight_unit,
      agentSku.estimated_weight_grams,
    );
    if (!weight && (definitions.has(A.netWeightGrams) || definitions.has(A.packagedWeightGrams))) {
      issue('error', 'NET_WEIGHT_UNRESOLVED', 'Net weight needs source grams/kilograms or an Agent estimate.', [skuId], [A.netWeightGrams]);
    } else if (weight) {
      addRaw(A.netWeightGrams, String(weight.grams), weight.provenance, weight.confidence, weight.evidence);
      addRaw(A.packagedWeightGrams, String(decimal(weight.grams + 50)), 'derived', weight.confidence, [
        ...weight.evidence,
        ...policy('attribute.4497.formula', 'net_weight_g + 50'),
      ]);
      if (weight.provenance === 'agent_estimated') {
        issue('warning', 'AGENT_ESTIMATED_ATTRIBUTE', 'Net weight was estimated by the Agent.', [skuId], [A.netWeightGrams]);
      }
    }

    addDictionary(A.originCountry, agentSku.origin_country ?? fixed(DEFAULTS.china, '中国', 'attribute.4389.default'), agentSku.origin_country ? 'source' : 'default');
    if (!definitions.has(A.productType)) {
      issue('error', 'PRODUCT_TYPE_ATTRIBUTE_NOT_AVAILABLE', 'Category snapshot does not expose attribute 8229.', [skuId], [A.productType]);
    } else {
      addDictionary(A.productType, agentSku.product_type, 'source');
    }
    addRaw(
      A.modelName,
      categoryDecision.product_structure === 'mixed_product'
        ? `${product.source.offer_id}-${groupId}`
        : product.source.offer_id,
      'derived',
      'high',
      policy('attribute.9048', groupId),
    );

    if (agentSku.colors) {
      addDictionary(A.color, agentSku.colors, 'source');
    } else {
      addDictionary(A.color, fixed(DEFAULTS.multicolor, '多色', 'attribute.10096.default'), 'default');
    }
    if (agentSku.factory_package_count) {
      addPositiveInteger(A.factoryPackageCount, agentSku.factory_package_count, 'source');
    } else {
      addRaw(A.factoryPackageCount, '1', 'default', 'high', policy('attribute.11650.default', '1'));
    }
    addText(A.hashtags, {
      ...agentSku.hashtags_ru,
      value: agentSku.hashtags_ru.value.join(' '),
    }, 'derived');
    if (agentSku.unified_unit_count) {
      addPositiveInteger(A.unifiedUnitCount, agentSku.unified_unit_count, 'source');
    }

    validateCopy(agentSku);
    for (const definition of definitionsList) {
      const rule = getOzonDraftAttributeRule(definition.id);
      if (definition.required && (!rule || rule.action === 'omit')) {
        issue('error', 'UNSUPPORTED_REQUIRED_ATTRIBUTE', `Required attribute ${definition.id} is not supported in V0.`, [skuId], [definition.id]);
      } else if ((definition.required || rule?.required_when_available) && !attributes.has(definition.id)) {
        issue('error', 'REQUIRED_ATTRIBUTE_MISSING', `Attribute ${definition.id} has no valid value.`, [skuId], [definition.id]);
      }
    }

    return {
      source_sku_id: skuId,
      group_id: groupId,
      description_category_id: selected.description_category_id,
      type_id: selected.type_id,
      name: agentSku.name_ru.value.trim(),
      attributes: [...attributes.values()].sort((left, right) => left.id - right.id),
    };

    function addDictionary(
      id: number,
      decision: OzonDraftAgentValueV1<OzonDraftDictionaryValueV1 | OzonDraftDictionaryValueV1[]>,
      provenance: OzonDraftProvenanceV1,
    ): void {
      const definition = definitions.get(id);
      if (!definition) return;
      if (decision.evidence.length === 0) {
        issue('error', 'ATTRIBUTE_EVIDENCE_MISSING', `Attribute ${id} has no evidence.`, [skuId], [id]);
        return;
      }
      const requested = Array.isArray(decision.value) ? decision.value : [decision.value];
      if (definition.dictionary_id <= 0 || definition.values.length === 0) {
        issue('error', 'DICTIONARY_NOT_AVAILABLE', `Attribute ${id} has no dictionary values.`, [skuId], [id]);
        return;
      }
      if (!definition.is_collection && requested.length > 1) {
        issue('error', 'DICTIONARY_VALUE_COUNT_INVALID', `Attribute ${id} accepts one value.`, [skuId], [id]);
        return;
      }
      const values = [...new Set(requested.map((value) => value.dictionary_value_id))].flatMap((valueId) => {
        const match = definition.values.find((value) => value.id === valueId);
        if (!match) {
          issue('error', 'DICTIONARY_VALUE_NOT_FOUND', `Dictionary value ${valueId} is invalid for attribute ${id}.`, [skuId], [id]);
          return [];
        }
        return [{ dictionary_value_id: match.id, value: match.value }];
      });
      if (values.length === 0) return;
      attributes.set(id, {
        id,
        complex_id: 0,
        values,
        provenance,
        confidence: decision.confidence,
        evidence: decision.evidence,
      });
      warnLowConfidence(id, decision.confidence);
    }

    function addText(
      id: number,
      decision: OzonDraftAgentValueV1<string>,
      provenance: OzonDraftProvenanceV1,
    ): void {
      if (!definitions.has(id)) return;
      const value = decision.value.trim();
      if (!value) {
        issue('error', 'ATTRIBUTE_TEXT_MISSING', `Attribute ${id} is empty.`, [skuId], [id]);
        return;
      }
      addRaw(id, value, provenance, decision.confidence, decision.evidence);
      warnLowConfidence(id, decision.confidence);
    }

    function addPositiveInteger(
      id: number,
      decision: OzonDraftAgentValueV1<number>,
      provenance: OzonDraftProvenanceV1,
    ): void {
      if (!definitions.has(id)) return;
      if (!Number.isInteger(decision.value) || decision.value <= 0) {
        issue('error', 'COUNT_VALUE_INVALID', `Attribute ${id} must be a positive integer.`, [skuId], [id]);
        return;
      }
      addRaw(id, String(decision.value), provenance, decision.confidence, decision.evidence);
      warnLowConfidence(id, decision.confidence);
    }

    function addRaw(
      id: number,
      value: string,
      provenance: OzonDraftProvenanceV1,
      confidence: OzonDraftConfidenceV1,
      evidence: OzonDraftEvidenceV1[],
    ): void {
      if (!definitions.has(id) || !value) return;
      if (evidence.length === 0) {
        issue('error', 'ATTRIBUTE_EVIDENCE_MISSING', `Attribute ${id} has no evidence.`, [skuId], [id]);
        return;
      }
      attributes.set(id, {
        id,
        complex_id: 0,
        values: [{ value }],
        provenance,
        confidence,
        evidence,
      });
    }

    function warnLowConfidence(id: number, confidence: OzonDraftConfidenceV1): void {
      if (confidence === 'low') {
        issue('warning', 'LOW_CONFIDENCE_ATTRIBUTE', `Attribute ${id} needs review.`, [skuId], [id]);
      }
    }

    function validateCopy(agent: OzonDraftAgentSkuInputV1): void {
      const name = agent.name_ru.value.trim();
      const description = agent.description_ru.value.trim();
      if (!hasCyrillic(name) || name.length > 200 || /[.!?,;:。，！？；：]$/u.test(name)) {
        issue('error', 'RUSSIAN_NAME_INVALID', 'Russian name is missing, too long, or ends with punctuation.', [skuId], [A.name]);
      }
      if (definitions.has(A.description) && !hasCyrillic(description)) {
        issue('error', 'RUSSIAN_DESCRIPTION_REQUIRED', 'Description must contain Russian text.', [skuId], [A.description]);
      }
      if (!definitions.has(A.hashtags)) return;
      const tags = agent.hashtags_ru.value;
      const normalized = new Set(tags.map((tag) => tag.toLocaleLowerCase('ru-RU')));
      if (
        tags.length < 20 ||
        tags.length > 30 ||
        normalized.size !== tags.length ||
        tags.some((tag) => !/^#[\p{Script=Cyrillic}\p{N}_]+$/u.test(tag) || tag.length > 30)
      ) {
        issue('error', 'HASHTAGS_INVALID', 'Use 20-30 unique Russian hashtags of at most 30 characters.', [skuId], [A.hashtags]);
      }
    }
  }

  function issue(
    severity: 'warning' | 'error',
    code: string,
    message: string,
    skuIds: string[] = [],
    attributeIds: number[] = [],
  ): void {
    issues.push({ severity, code, message, sku_ids: [...new Set(skuIds)], attribute_ids: [...new Set(attributeIds)] });
  }
}

function uniqueMap<T>(values: T[], keyOf: (value: T) => string, duplicate: (key: string) => void): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    const key = keyOf(value);
    if (result.has(key)) duplicate(key);
    else result.set(key, value);
  }
  return result;
}

function positive(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

function decimal(value: number): number {
  return Number(value.toFixed(6));
}

function hasCyrillic(value: string): boolean {
  return /[\p{Script=Cyrillic}]/u.test(value);
}
