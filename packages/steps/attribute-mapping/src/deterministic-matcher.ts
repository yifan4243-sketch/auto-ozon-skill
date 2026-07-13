import type {
  CanonicalProductV2,
  CanonicalSkuV2,
  CategoryAttributeV1,
  MappedOzonAttributeV1,
} from '@auto-ozon/contracts';
import { resolveDictionaryValue } from './dictionary-resolver.js';
import { extractProductFacts, normalizeFactText } from './product-fact-extractor.js';
import { normalizedNetWeightGrams } from './unit-normalizer.js';

const ATTRIBUTE = {
  brand: 85,
  netWeight: 4383,
  originCountry: 4389,
  packagedWeight: 4497,
  factoryPackageCount: 11650,
} as const;

const DEFAULT_DICTIONARY = {
  noBrand: 126745801,
  china: 90296,
} as const;

export function matchDeterministicAttribute(
  product: CanonicalProductV2,
  sku: CanonicalSkuV2,
  attribute: CategoryAttributeV1,
): MappedOzonAttributeV1 | null {
  const weight = normalizedNetWeightGrams(sku);
  if (attribute.id === ATTRIBUTE.netWeight && weight !== null) {
    return mapped(attribute.id, String(weight), 'converted', 'high', 'sku.package.raw_weight');
  }
  if (attribute.id === ATTRIBUTE.packagedWeight && weight !== null) {
    return mapped(attribute.id, String(weight + 50), 'derived', 'high', 'net_weight + 50g');
  }
  if (attribute.id === ATTRIBUTE.factoryPackageCount && attribute.dictionary_id === 0) {
    return mapped(attribute.id, '1', 'default', 'medium', 'default factory package count');
  }

  const facts = extractProductFacts(product, sku);
  const name = normalizeFactText(attribute.name);
  const fact = facts.find((candidate) => normalizeFactText(candidate.name) === name);
  if (fact) {
    if (attribute.dictionary_id > 0) {
      const value = resolveDictionaryValue(attribute, fact.value);
      if (!value) return null;
      return {
        attribute_id: attribute.id,
        values: [value],
        provenance: 'source',
        confidence: 'high',
        evidence: [{ source: 'canonical_v2', field: fact.field, value: fact.value }],
      };
    }
    return mapped(attribute.id, fact.value, 'source', 'high', fact.field);
  }

  if (attribute.id === ATTRIBUTE.brand) {
    return dictionaryDefault(attribute, DEFAULT_DICTIONARY.noBrand, 'no brand policy');
  }
  if (attribute.id === ATTRIBUTE.originCountry) {
    return dictionaryDefault(attribute, DEFAULT_DICTIONARY.china, '1688 source country policy');
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
