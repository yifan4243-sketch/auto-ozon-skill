import type {
  AttributeMappingEvidenceV1,
  AttributeMappingEvidenceV2,
  AttributeMappingV1,
  AttributeMappingV2,
  CanonicalProductV2,
  CommandResult,
  MappedOzonAttributeV1,
  MappedOzonAttributeV2,
} from '@auto-ozon/contracts';
import { sha256Json, type WorkflowContext } from '@auto-ozon/artifact-store';
import { runAttributeMapping, type RunAttributeMappingInput } from './service.js';

export async function runAttributeMappingV2(
  input: RunAttributeMappingInput,
  context?: WorkflowContext,
): Promise<CommandResult<AttributeMappingV2>> {
  const legacy = await runAttributeMapping(input);
  if (!legacy.data) return { ...legacy, data: undefined };
  const v2 = convert(input.product, legacy.data, input);
  if (context) {
    const output = await context.artifact_store.write(context.run_id, 'attribute-mapping', 'attribute-mapping-v2.json', v2);
    await context.artifact_store.updateStep(context.run_id, 'attribute-mapping', {
      status: v2.status === 'completed' ? 'succeeded' : v2.status,
      output,
      step_version: '2.0.0',
    });
  }
  return { ...legacy, data: v2 };
}

function convert(product: CanonicalProductV2, mapping: AttributeMappingV1, input: RunAttributeMappingInput): AttributeMappingV2 {
  const convertAttribute = (attribute: MappedOzonAttributeV1, sourceSkuId?: string): MappedOzonAttributeV2 => ({
    ...attribute,
    evidence: attribute.evidence.map((evidence) => evidenceV2(product, attribute, evidence, sourceSkuId)),
  });
  return {
    schema_version: 2,
    source_offer_id: mapping.source_offer_id,
    status: mapping.status,
    snapshot_refs: input.category_attributes.map((group) => ({
      group_id: group.group_ids.join(','),
      description_category_id: group.category.description_category_id,
      type_id: group.category.type_id,
      fetched_at: group.attributes_schema.fetched_at,
      sha256: sha256Json(group.attributes_schema),
    })),
    common_attributes: mapping.common_attributes.map((entry) => ({ ...entry, attribute: convertAttribute(entry.attribute) })),
    variant_attributes: mapping.variant_attributes,
    sku_attributes: mapping.sku_attributes.map((sku) => ({
      ...sku,
      attributes: sku.attributes.map((attribute) => convertAttribute(attribute, sku.source_sku_id)),
    })),
    missing_required_attributes: mapping.missing_required_attributes,
    unresolved_attributes: mapping.unresolved_attributes,
    warnings: mapping.warnings,
    errors: mapping.errors,
  };
}

function evidenceV2(
  product: CanonicalProductV2,
  attribute: MappedOzonAttributeV1,
  evidence: AttributeMappingEvidenceV1,
  sourceSkuId?: string,
): AttributeMappingEvidenceV2 {
  const sku = sourceSkuId ? product.skus.find((item) => item.source_sku_id === sourceSkuId) : undefined;
  if (attribute.attribute_id === 4497 && sku) {
    return {
      source: 'canonical_v2',
      source_path: `skus[source_sku_id=${sourceSkuId}].package.raw_weight`,
      source_value: sku.package.raw_weight,
      normalized_value: attribute.values.map((value) => value.value).join('|'),
    };
  }
  return {
    source: evidence.source,
    source_path: evidence.field,
    source_value: evidence.value,
    normalized_value: attribute.values.map((value) => value.value).join('|'),
  };
}
