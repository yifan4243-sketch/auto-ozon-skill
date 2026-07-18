import type {
  AttributeMappingV2,
  CanonicalProductV2,
  CategoryAttributesGroupV1,
  CategoryDecisionV1,
} from '@auto-ozon/contracts';
import { validateDictionaryValues } from './dictionary-resolver.js';
import { resolveGroupAttributeSnapshot } from './variant-mapper.js';

export function validateAttributeMapping(
  mapping: AttributeMappingV2,
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
      const sortedIds = sku.attributes.map((attribute) => attribute.attribute_id);
      if (JSON.stringify(sortedIds) !== JSON.stringify([...sortedIds].sort((a, b) => a - b))) {
        violations.push(`ATTRIBUTE_ORDER_INVALID:${sku.source_sku_id}`);
      }
      for (const mapped of sku.attributes) {
        const schema = byId.get(mapped.attribute_id);
        if (!schema) violations.push(`UNKNOWN_ATTRIBUTE:${mapped.attribute_id}`);
        else if (!validateDictionaryValues(schema, mapped.values)) {
          violations.push(`INVALID_DICTIONARY_VALUE:${mapped.attribute_id}`);
        }
      }
      const expectedOzon = sku.attributes.map((mapped) => ({
        id: mapped.attribute_id,
        complex_id: sku.ozon_attributes.find((attribute) => attribute.id === mapped.attribute_id)?.complex_id ?? 0,
        values: mapped.values,
      }));
      if (JSON.stringify(expectedOzon) !== JSON.stringify(sku.ozon_attributes)) {
        violations.push(`OZON_ATTRIBUTES_MISMATCH:${sku.source_sku_id}`);
      }
    }
  }
  return violations;
}
