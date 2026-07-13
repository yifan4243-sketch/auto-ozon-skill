import type {
  AttributeMappingAgentInputV1,
  AttributeMappingV1,
  CanonicalProductV2,
  CategoryAttributesGroupV1,
  CategoryDecisionV1,
  CommandResult,
  MappedOzonAttributeV1,
  SkuAttributeMappingV1,
} from '@auto-ozon/contracts';
import type { WorkflowContext } from '@auto-ozon/artifact-store';
import { assertWorkflowActive } from '@auto-ozon/artifact-store';
import { resolveAgentAttribute } from './agent-resolver.js';
import { classifyGroupAttributes } from './attribute-classifier.js';
import { matchDeterministicAttribute } from './deterministic-matcher.js';
import { validateAttributeMapping } from './validator.js';
import { resolveGroupAttributeSnapshot } from './variant-mapper.js';
import { validateAttributeMappingSchema } from './schema-validator.js';

const DRAFT_OWNED_CONTENT_ATTRIBUTE_IDS = new Set([4180, 4191, 23171]);

export interface RunAttributeMappingInput {
  product: CanonicalProductV2;
  category_decision: CategoryDecisionV1;
  category_attributes: CategoryAttributesGroupV1[];
  agent_input?: AttributeMappingAgentInputV1;
}

export async function runAttributeMapping(
  input: RunAttributeMappingInput,
  context?: WorkflowContext,
): Promise<CommandResult<AttributeMappingV1>> {
  try {
    if (context) {
      assertWorkflowActive(context);
      await context.artifact_store.updateStep(context.run_id, 'attribute-mapping', {
        status: 'running',
      });
    }
    const mapping = buildMapping(input);
    const violations = validateAttributeMapping(
      mapping,
      input.product,
      input.category_decision,
      input.category_attributes,
    );
    for (const violation of violations) {
      mapping.errors.push({
        code: 'ATTRIBUTE_MAPPING_INVALID',
        message: violation,
        sku_ids: [],
        attribute_ids: [],
      });
    }
    if (mapping.errors.length > 0) mapping.status = 'blocked';
    const schema = validateAttributeMappingSchema(mapping);
    if (!schema.valid) {
      mapping.errors.push(issue(
        'ATTRIBUTE_MAPPING_SCHEMA_INVALID',
        `AttributeMappingV1 schema validation failed: ${schema.errors.join('; ')}`,
      ));
      mapping.status = 'blocked';
    }

    if (context) {
      const output = await context.artifact_store.write(
        context.run_id,
        'attribute-mapping',
        'attribute-mapping-v1.json',
        mapping,
      );
      await context.artifact_store.updateStep(context.run_id, 'attribute-mapping', {
        status: mapping.status === 'completed' ? 'succeeded' : mapping.status,
        output,
      });
    }
    return {
      ok: mapping.status !== 'blocked',
      command: 'attribute.mapping',
      data: mapping,
      warnings: mapping.warnings.map((warning) => ({
        code: warning.code,
        message: warning.message,
        detail: warning,
      })),
      errors: mapping.errors.map((error) => ({
        code: error.code,
        message: error.message,
        detail: error,
        recoverable: true,
      })),
      nextActions:
        mapping.status === 'needs_review'
          ? ['Review low-confidence or unresolved attribute mappings.']
          : [],
    };
  } catch (error) {
    if (context) {
      await context.artifact_store.updateStep(context.run_id, 'attribute-mapping', {
        status: 'failed',
        error_code: 'ATTRIBUTE_MAPPING_FAILED',
      });
    }
    return {
      ok: false,
      command: 'attribute.mapping',
      warnings: [],
      errors: [{
        code: 'ATTRIBUTE_MAPPING_FAILED',
        message: error instanceof Error ? error.message : String(error),
        recoverable: true,
      }],
      nextActions: [],
    };
  }
}

function buildMapping(input: RunAttributeMappingInput): AttributeMappingV1 {
  const result: AttributeMappingV1 = {
    schema_version: 1,
    source_offer_id: input.product.source.offer_id,
    status: 'completed',
    common_attributes: [],
    variant_attributes: [],
    sku_attributes: [],
    missing_required_attributes: [],
    unresolved_attributes: [],
    warnings: [],
    errors: [],
  };
  if (input.product.validation.status === 'blocked' || input.category_decision.status === 'blocked') {
    result.errors.push(issue('BLOCKED_UPSTREAM', 'Blocked source or category decision cannot be mapped.'));
    return { ...result, status: 'blocked' };
  }
  if (input.product.source.offer_id !== input.category_decision.source_offer_id) {
    result.errors.push(issue('OFFER_ID_MISMATCH', 'Product and category decision offer IDs differ.'));
  }
  if (input.agent_input && input.agent_input.source_offer_id !== input.product.source.offer_id) {
    result.errors.push(issue('AGENT_OFFER_ID_MISMATCH', 'Agent input belongs to another offer.'));
  }

  for (const group of input.category_decision.category_groups) {
    const snapshot = resolveGroupAttributeSnapshot(group, input.category_attributes);
    if (!snapshot || !group.selected_category) {
      result.errors.push(issue(
        'CATEGORY_ATTRIBUTES_GROUP_MISMATCH',
        `Group ${group.group_id} has no matching attribute snapshot.`,
        group.source_sku_ids,
      ));
      continue;
    }
    const groupMappings: SkuAttributeMappingV1[] = [];
    for (const sourceSkuId of group.source_sku_ids) {
      const sku = input.product.skus.find((candidate) => candidate.source_sku_id === sourceSkuId);
      if (!sku) {
        result.errors.push(issue('UNKNOWN_SKU', `Unknown source SKU ${sourceSkuId}.`, [sourceSkuId]));
        continue;
      }
      const attributes: MappedOzonAttributeV1[] = [];
      for (const schema of snapshot.attributes_schema.attributes) {
        if (DRAFT_OWNED_CONTENT_ATTRIBUTE_IDS.has(schema.id)) continue;
        const deterministic = matchDeterministicAttribute(input.product, sku, schema);
        const agent = resolveAgentAttribute(input.agent_input, sourceSkuId, schema);
        const mapped = deterministic ?? agent.attribute;
        if (agent.error) {
          result.unresolved_attributes.push({
            group_id: group.group_id,
            attribute_id: schema.id,
            attribute_name: schema.name,
            source_sku_ids: [sourceSkuId],
            reason: agent.error,
          });
        }
        if (mapped) {
          attributes.push(mapped);
          if (mapped.confidence === 'low') {
            result.warnings.push(issue(
              'LOW_CONFIDENCE_ATTRIBUTE',
              `Attribute ${schema.id} has low confidence.`,
              [sourceSkuId],
              [schema.id],
            ));
          }
        } else if (schema.required) {
          result.missing_required_attributes.push({
            group_id: group.group_id,
            attribute_id: schema.id,
            attribute_name: schema.name,
            source_sku_ids: [sourceSkuId],
          });
          result.unresolved_attributes.push({
            group_id: group.group_id,
            attribute_id: schema.id,
            attribute_name: schema.name,
            source_sku_ids: [sourceSkuId],
            reason: agent.error ?? 'no_source_match',
          });
        }
      }
      groupMappings.push({
        source_sku_id: sourceSkuId,
        group_id: group.group_id,
        description_category_id: group.selected_category.description_category_id,
        type_id: group.selected_category.type_id,
        attributes,
      });
    }
    result.sku_attributes.push(...groupMappings);
    const classified = classifyGroupAttributes(group.group_id, groupMappings);
    result.common_attributes.push(...classified.common);
    result.variant_attributes.push(...classified.variant);
  }
  if (result.missing_required_attributes.length > 0) {
    result.errors.push(issue(
      'MISSING_REQUIRED_ATTRIBUTES',
      'One or more required Ozon attributes could not be mapped.',
      [...new Set(result.missing_required_attributes.flatMap((missing) => missing.source_sku_ids))],
      [...new Set(result.missing_required_attributes.map((missing) => missing.attribute_id))],
    ));
  }
  result.status = result.errors.length > 0
    ? 'blocked'
    : result.warnings.length > 0 || result.unresolved_attributes.length > 0
      ? 'needs_review'
      : 'completed';
  return result;
}

function issue(
  code: string,
  message: string,
  skuIds: string[] = [],
  attributeIds: number[] = [],
) {
  return { code, message, sku_ids: skuIds, attribute_ids: attributeIds };
}
