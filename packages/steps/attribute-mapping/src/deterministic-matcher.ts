import type {
  CanonicalProductV2,
  CanonicalSkuV2,
  CategoryAttributeV1,
  CostPricingV1,
  MappedOzonAttributeV1,
} from '@auto-ozon/contracts';
import { extractProductFacts, normalizeFactText } from './product-fact-extractor.js';
import { normalizedNetWeightGrams, parseWeightTextToGrams } from './unit-normalizer.js';

const ATTRIBUTE = {
  brand: 85,
  netWeight: 4383,
  packagedWeight: 4497,
  originCountry: 4389,
  modelName: 9048,
  factoryPackageCount: 11650,
  unifiedItemCount: 23249,
} as const;

const DEFAULT_DICTIONARY = {
  noBrand: 126745801,
  china: 90296,
} as const;

export function matchDeterministicAttribute(
  product: CanonicalProductV2,
  sku: CanonicalSkuV2,
  attribute: CategoryAttributeV1,
  runTimestamp: string,
  costPricing?: CostPricingV1,
): MappedOzonAttributeV1 | null {
  if (attribute.id === ATTRIBUTE.brand) {
    return fixedDictionaryDefault(
      attribute.id,
      DEFAULT_DICTIONARY.noBrand,
      'Нет бренда',
      'locked no-brand policy',
    );
  }
  if (attribute.id === ATTRIBUTE.originCountry) {
    return dictionaryDefault(attribute, DEFAULT_DICTIONARY.china, '1688 source country policy');
  }

  const costEntry = costPricing?.sku_pricing.find((entry) => entry.source_sku_id === sku.source_sku_id);
  const costWeight = costEntry?.weight_facts?.cost_base_weight_g ?? costEntry?.package.actual_weight_g;
  if (attribute.id === ATTRIBUTE.netWeight && costWeight && costWeight > 3) {
    return costDerived(attribute.id, costEntry?.weight_facts?.attribute_4383_weight_g ?? costWeight, 'weight_facts.attribute_4383_weight_g');
  }
  if (attribute.id === ATTRIBUTE.packagedWeight && costWeight && costWeight > 3) {
    return costDerived(attribute.id, costEntry?.weight_facts?.attribute_4497_weight_g ?? costWeight + 50, 'weight_facts.attribute_4497_weight_g');
  }
  const weight = sourceNetWeightGrams(product, sku);
  if (attribute.id === ATTRIBUTE.netWeight && weight !== null) {
    return mapped(attribute.id, String(weight), 'converted', 'high', 'sku.package.raw_weight');
  }
  if (attribute.id === ATTRIBUTE.modelName && attribute.dictionary_id === 0) {
    return mapped(attribute.id, runTimestamp, 'default', 'medium', 'run.created_at');
  }
  if (attribute.id === ATTRIBUTE.factoryPackageCount && attribute.dictionary_id === 0) {
    return mapped(attribute.id, '1', 'default', 'medium', 'default factory package count');
  }
  if (attribute.id === ATTRIBUTE.unifiedItemCount && attribute.dictionary_id === 0) {
    return mapped(attribute.id, '1', 'default', 'medium', 'default unified item count');
  }
  return null;
}

function costDerived(attributeId: number, weight: number, field: string): MappedOzonAttributeV1 {
  return {
    attribute_id: attributeId,
    values: [{ value: String(weight) }],
    provenance: 'derived',
    confidence: 'low',
    evidence: [{ source: 'cost_pricing', field, value: String(weight) }],
  };
}

export function formatRunTimestamp(createdAt: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid run created_at: ${createdAt}`);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const byType = new Map<string, string>(parts.map((part) => [part.type, part.value]));
  return ['year', 'month', 'day', 'hour', 'minute', 'second']
    .map((part) => byType.get(part) ?? '')
    .join('');
}

function sourceNetWeightGrams(product: CanonicalProductV2, sku: CanonicalSkuV2): number | null {
  const packaged = normalizedNetWeightGrams(sku);
  if (packaged !== null) return packaged;
  const weightNames = ['净重', '商品重量', '产品重量', '重量', '克重', '单重'];
  for (const fact of extractProductFacts(product, sku)) {
    const name = normalizeFactText(fact.name);
    if (!weightNames.some((candidate) => name.includes(normalizeFactText(candidate)))) continue;
    const grams = parseWeightTextToGrams(fact.value);
    if (grams !== null) return grams;
  }
  return null;
}

function dictionaryDefault(
  attribute: CategoryAttributeV1,
  id: number,
  field: string,
): MappedOzonAttributeV1 | null {
  const value = attribute.values.find((candidate) => candidate.id === id);
  if (!value) return null;
  return {
    attribute_id: attribute.id,
    values: [{ dictionary_value_id: value.id, value: value.value }],
    provenance: 'default',
    confidence: 'medium',
    evidence: [{ source: 'policy', field, value: value.value }],
  };
}

function fixedDictionaryDefault(
  attributeId: number,
  dictionaryValueId: number,
  value: string,
  field: string,
): MappedOzonAttributeV1 {
  return {
    attribute_id: attributeId,
    values: [{ dictionary_value_id: dictionaryValueId, value }],
    provenance: 'default',
    confidence: 'medium',
    evidence: [{ source: 'policy', field, value }],
  };
}

function mapped(
  attributeId: number,
  value: string,
  provenance: MappedOzonAttributeV1['provenance'],
  confidence: MappedOzonAttributeV1['confidence'],
  field: string,
): MappedOzonAttributeV1 {
  return {
    attribute_id: attributeId,
    values: [{ value }],
    provenance,
    confidence,
    evidence: [{ source: provenance === 'source' ? 'canonical_v2' : 'policy', field, value }],
  };
}
