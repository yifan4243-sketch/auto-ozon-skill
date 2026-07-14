import type {
  CanonicalProductV2,
  CanonicalSkuV2,
  CategoryAttributeV1,
  MappedOzonAttributeV1,
} from '@auto-ozon/contracts';
import { resolveDictionaryValue } from './dictionary-resolver.js';
import { extractProductFacts, normalizeFactText } from './product-fact-extractor.js';
import { normalizedPackagedWeightGrams } from './unit-normalizer.js';

const ATTRIBUTE = {
  brand: 85,
  packagedWeight: 4497,
} as const;

export function matchDeterministicAttribute(
  product: CanonicalProductV2,
  sku: CanonicalSkuV2,
  attribute: CategoryAttributeV1,
): MappedOzonAttributeV1 | null {
  const weight = normalizedPackagedWeightGrams(sku);
  if (attribute.id === ATTRIBUTE.packagedWeight && weight !== null) {
    return mapped(attribute.id, String(weight), 'converted', 'high', 'skus[].package.raw_weight');
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

  return null;
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
