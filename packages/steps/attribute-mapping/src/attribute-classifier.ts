import type {
  CommonAttributeMappingV1,
  SkuAttributeMappingV1,
  VariantAttributeMappingV1,
} from '@auto-ozon/contracts';

export function classifyGroupAttributes(
  groupId: string,
  skuMappings: SkuAttributeMappingV1[],
): {
  common: CommonAttributeMappingV1[];
  variant: VariantAttributeMappingV1[];
} {
  const attributeIds = new Set(
    skuMappings.flatMap((sku) => sku.attributes.map((attribute) => attribute.attribute_id)),
  );
  const common: CommonAttributeMappingV1[] = [];
  const variant: VariantAttributeMappingV1[] = [];

  for (const attributeId of attributeIds) {
    const bySku = Object.fromEntries(
      skuMappings.map((sku) => [
        sku.source_sku_id,
        sku.attributes.find((attribute) => attribute.attribute_id === attributeId)?.values ?? [],
      ]),
    );
    const serialized = Object.values(bySku).map((values) => JSON.stringify(values));
    if (serialized.length > 0 && serialized.every((value) => value === serialized[0])) {
      const attribute = skuMappings[0]?.attributes.find(
        (candidate) => candidate.attribute_id === attributeId,
      );
      if (attribute) common.push({ group_id: groupId, attribute });
    } else {
      variant.push({ group_id: groupId, attribute_id: attributeId, values_by_sku: bySku });
    }
  }
  return { common, variant };
}
