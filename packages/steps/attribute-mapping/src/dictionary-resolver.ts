import type {
  AttributeMappingValueV1,
  CategoryAttributeV1,
} from '@auto-ozon/contracts';
import { normalizeFactText } from './product-fact-extractor.js';

export function resolveDictionaryValue(
  attribute: CategoryAttributeV1,
  sourceValue: string,
): AttributeMappingValueV1 | null {
  const normalized = normalizeFactText(sourceValue);
  const match = attribute.values.find((candidate) =>
    [candidate.value, candidate.info ?? ''].some(
      (value) => normalizeFactText(value) === normalized,
    ),
  );
  return match ? { dictionary_value_id: match.id, value: match.value } : null;
}

export function validateDictionaryValues(
  attribute: CategoryAttributeV1,
  values: AttributeMappingValueV1[],
): boolean {
  if (attribute.dictionary_id <= 0) {
    return values.every((value) => value.dictionary_value_id === undefined);
  }
  if (attribute.id === 85) {
    return values.length === 1 && values[0]?.dictionary_value_id === 126745801;
  }
  return values.every((value) => {
    if (!value.dictionary_value_id) return false;
    const match = attribute.values.find((candidate) => candidate.id === value.dictionary_value_id);
    return Boolean(match && normalizeFactText(match.value) === normalizeFactText(value.value));
  });
}
