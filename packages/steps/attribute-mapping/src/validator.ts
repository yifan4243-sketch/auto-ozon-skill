import type {
  AttributeMappingV1,
  CanonicalProductV2,
  CategoryAttributesGroupV1,
  CategoryDecisionV1,
} from '@auto-ozon/contracts';
import { validateDictionaryValues } from './dictionary-resolver.js';
import { resolveGroupAttributeSnapshot } from './variant-mapper.js';

export function validateAttributeMapping(
  mapping: AttributeMappingV1,
  product: CanonicalProductV2,
  decision: CategoryDecisionV1,
  snapshots: CategoryAttributesGroupV1[],
): string[] {
  const violations: string[] = [];
  const sourceSkuIds = product.skus.map((sku) => sku.source_sku_id).sort();
  const mappedSkuIds = mapping.sku_attributes.map((sku) => sku.source_sku_id).sort();
  if (JSON.stringify(sourceSkuIds) !== JSON.stringify(mappedSkuIds)) {
    violations.push('SKU_COVERAGE_MISMATCH');
  }
  for (const group of decision.category_groups) {
    const snapshot = resolveGroupAttributeSnapshot(group, snapshots);
    if (!snapshot) {
      violations.push(`CATEGORY_ATTRIBUTES_GROUP_MISMATCH:${group.group_id}`);
      continue;
    }
    const byId = new Map(snapshot.attributes_schema.attributes.map((attribute) => [attribute.id, attribute]));
    for (const sku of mapping.sku_attributes.filter((candidate) => candidate.group_id === group.group_id)) {
      for (const mapped of sku.attributes) {
        const schema = byId.get(mapped.attribute_id);
        if (!schema) violations.push(`UNKNOWN_ATTRIBUTE:${mapped.attribute_id}`);
        else if (!['String', 'Integer', 'Decimal', 'Boolean', 'URL'].includes(schema.type)) {
          violations.push(`UNSUPPORTED_ATTRIBUTE_TYPE:${mapped.attribute_id}:${schema.type}`);
        } else if (!validateDictionaryValues(schema, mapped.values)) {
          violations.push(`INVALID_DICTIONARY_VALUE:${mapped.attribute_id}`);
        } else if (!schema.is_collection && mapped.values.length !== 1) {
          violations.push(`NON_COLLECTION_VALUE_COUNT:${mapped.attribute_id}`);
        } else if (schema.is_collection && new Set(mapped.values.map((value) => `${value.dictionary_value_id ?? ''}:${value.value}`)).size !== mapped.values.length) {
          violations.push(`DUPLICATE_COLLECTION_VALUE:${mapped.attribute_id}`);
        }
      }
    }
  }
  return violations;
}
