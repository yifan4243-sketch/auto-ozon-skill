import type {
  AttributeMappingAgentInputV1,
  AttributeMappingV1,
  CanonicalProductV2,
  CategoryAttributesGroupV1,
  CategoryDecisionV1,
  CommandResult,
  CostPricingV1,
  MappedOzonAttributeV1,
  OzonReadyAttributeV1,
  SkuAttributeMappingV1,
} from '@auto-ozon/contracts';
import { LEGACY_WEIGHT_SEMANTICS_V1 } from '@auto-ozon/contracts';
import type { WorkflowContext } from '@auto-ozon/artifact-store';
import { assertWorkflowActive } from '@auto-ozon/artifact-store';
import { resolveAgentAttribute } from './agent-resolver.js';
import { classifyGroupAttributes } from './attribute-classifier.js';
import { formatRunTimestamp, matchDeterministicAttribute } from './deterministic-matcher.js';
import { validateAttributeMapping } from './validator.js';
import { resolveGroupAttributeSnapshot } from './variant-mapper.js';
import { validateAttributeMappingSchema } from './schema-validator.js';
import {
  buildAgentTask,
  isBusinessRequired,
  shouldProcessAttribute,
  shouldRequestAgent,
} from './agent-task-builder.js';

export interface RunAttributeMappingInput {
  product: CanonicalProductV2;
  category_decision: CategoryDecisionV1;
  category_attributes: CategoryAttributesGroupV1[];
  cost_pricing?: CostPricingV1;
  agent_input?: AttributeMappingAgentInputV1;
  run_created_at?: string;
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
    const manifest = context
      ? await context.artifact_store.readManifest(context.run_id)
      : null;
    const runTimestamp = formatRunTimestamp(
      input.run_created_at ?? manifest?.created_at ?? input.product.source.collected_at,
    );
    const mapping = buildMapping(input, runTimestamp);
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
        mapping.agent_tasks.length > 0
          ? ['Have the current Agent complete agent_tasks, then rerun attribute-mapping with that Agent JSON.']
          : mapping.status === 'needs_review'
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

function buildMapping(input: RunAttributeMappingInput, runTimestamp: string): AttributeMappingV1 {
  const result: AttributeMappingV1 = {
    schema_version: 1,
    source_offer_id: input.product.source.offer_id,
    status: 'completed',
    weight_semantics: LEGACY_WEIGHT_SEMANTICS_V1,
    common_attributes: [],
    variant_attributes: [],
    sku_attributes: [],
    agent_tasks: [],
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
  const sourceBrands = sourceBrandValues(input.product);
  if (sourceBrands.length > 0) {
    result.warnings.push(issue(
      'SOURCE_BRAND_OVERRIDDEN_NO_BRAND',
      `Source brand facts (${sourceBrands.join(', ')}) were retained for audit but attribute 85 is forced to dictionary ID 126745801 by store policy.`,
      input.product.skus.map((sku) => sku.source_sku_id),
      [85],
    ));
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
        if (!shouldProcessAttribute(schema)) continue;
        const deterministic = matchDeterministicAttribute(
          input.product,
          sku,
          schema,
          runTimestamp,
          input.cost_pricing,
        );
        const agent = deterministic
          ? { attribute: null, error: null }
          : resolveAgentAttribute(
              input.agent_input,
              sourceSkuId,
              schema,
              sourceBrands,
            );
        const mapped = deterministic ?? agent.attribute;
        if (mapped) {
          attributes.push(mapped);
          if (mapped.confidence === 'low' && ![4383, 4497].includes(schema.id)) {
            result.warnings.push(issue(
              'LOW_CONFIDENCE_ATTRIBUTE',
              `Attribute ${schema.id} has low confidence.`,
              [sourceSkuId],
              [schema.id],
            ));
          }
        } else {
          if (isBusinessRequired(schema)) {
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
          if (shouldRequestAgent(schema) && (!input.agent_input || isBusinessRequired(schema))) {
            result.agent_tasks.push(buildAgentTask(input.product, sku, group.group_id, schema));
          }
        }
      }
      attributes.sort((left, right) => left.attribute_id - right.attribute_id);
      groupMappings.push({
        source_sku_id: sourceSkuId,
        group_id: group.group_id,
        description_category_id: group.selected_category.description_category_id,
        type_id: group.selected_category.type_id,
        attributes,
        ozon_attributes: attributes.map((attribute): OzonReadyAttributeV1 => ({
          id: attribute.attribute_id,
          complex_id: resolveComplexId(snapshot.attributes_schema.raw_response, attribute.attribute_id),
          values: attribute.values,
        })),
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
  const reviewWarnings = result.warnings.filter((warning) => warning.code !== 'SOURCE_BRAND_OVERRIDDEN_NO_BRAND');
  result.status = result.errors.length > 0
    ? 'blocked'
    : reviewWarnings.length > 0 || result.unresolved_attributes.length > 0
      ? 'needs_review'
      : 'completed';
  return result;
}

function resolveComplexId(raw: unknown, attributeId: number): number {
  const queue: unknown[] = [raw];
  while (queue.length > 0) {
    const current = queue.shift();
    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }
    if (!current || typeof current !== 'object') continue;
    const object = current as Record<string, unknown>;
    if (
      Number(object.id) === attributeId &&
      Object.prototype.hasOwnProperty.call(object, 'attribute_complex_id')
    ) {
      const complexId = Number(object.attribute_complex_id);
      return Number.isInteger(complexId) && complexId >= 0 ? complexId : 0;
    }
    queue.push(...Object.values(object));
  }
  return 0;
}

function sourceBrandValues(product: CanonicalProductV2): string[] {
  const ignored = new Set(['其他', '其它', 'other', '无品牌', '没有品牌', 'no brand', 'none']);
  return Object.entries(product.product.attributes)
    .filter(([name]) => /品牌|brand/iu.test(name))
    .map(([, value]) => value.normalize('NFKC').trim().toLocaleLowerCase())
    .filter((value) => value && !ignored.has(value));
}

function issue(
  code: string,
  message: string,
  skuIds: string[] = [],
  attributeIds: number[] = [],
) {
  return { code, message, sku_ids: skuIds, attribute_ids: attributeIds };
}
