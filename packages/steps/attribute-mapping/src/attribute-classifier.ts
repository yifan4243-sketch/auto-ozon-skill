import type { MappedOzonAttributeV2, SkuAttributeMappingV1, VariantAttributeMappingV1 } from '@auto-ozon/contracts';

type SkuAttributeMappingV2 = Omit<SkuAttributeMappingV1, 'attributes'> & { attributes: MappedOzonAttributeV2[] };

export function classifyGroupAttributes(
  groupId: string,
  skuMappings: SkuAttributeMappingV2[],
): {
  common: Array<{ group_id: string; attribute: MappedOzonAttributeV2 }>;
  variant: VariantAttributeMappingV1[];
} {
  const attributeIds = new Set(
    skuMappings.flatMap((sku) => sku.attributes.map((attribute) => attribute.attribute_id)),
  );
  const common: Array<{ group_id: string; attribute: MappedOzonAttributeV2 }> = [];
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
