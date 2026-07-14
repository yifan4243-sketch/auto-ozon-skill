import type {
  AttributeMappingEvidenceV1,
  AttributeMappingEvidenceV2,
  AttributeMappingProvenanceV1,
  AttributeMappingV1,
  AttributeMappingV2,
  CanonicalProductV2,
  CategoryAttributesGroupV1,
  CategoryDecisionV1,
  CommandResult,
  OzonDraftAttributeV1,
  OzonDraftContentInputV1,
  OzonDraftIssueV1,
  OzonDraftSkuV1,
  OzonDraftValidationV1,
  OzonProductDraftV1,
  OzonProductDraftV2,
} from '@auto-ozon/contracts';
import type { WorkflowContext } from '@auto-ozon/artifact-store';
import { assertWorkflowActive } from '@auto-ozon/artifact-store';
import { saveOzonDraftBundle } from '@auto-ozon/core';
import { sha256Json } from '@auto-ozon/artifact-store';

const CONTENT_ATTRIBUTE_IDS = new Set([4180, 4191, 23171]);

export interface RunDraftGenerationInput {
  attribute_mapping: AttributeMappingV1 | AttributeMappingV2;
  category_attributes: CategoryAttributesGroupV1[];
  content: OzonDraftContentInputV1;
  products_dir?: string;
}

export interface RunDraftGenerationV2Input extends RunDraftGenerationInput {
  product: CanonicalProductV2;
  category_decision: CategoryDecisionV1;
}

export async function runDraftGenerationV2(
  input: RunDraftGenerationV2Input,
  context?: WorkflowContext,
): Promise<CommandResult<OzonProductDraftV2>> {
  const legacy = await runDraftGeneration(input, context);
  if (!legacy.data) return { ...legacy, data: undefined };
  const draft = legacy.data;
  const errors = [...draft.errors];
  const sourceSkuIds = [...input.product.skus.map((sku) => sku.source_sku_id)].sort();
  const draftSkuIds = [...draft.items.map((item) => item.source_sku_id)].sort();
  if (input.product.source.offer_id !== draft.source_offer_id ||
      input.category_decision.source_offer_id !== draft.source_offer_id) {
    errors.push({ code: 'UPSTREAM_OFFER_ID_MISMATCH', message: 'Draft upstream offer IDs differ.', sku_ids: [], attribute_ids: [] });
  }
  if (JSON.stringify(sourceSkuIds) !== JSON.stringify(draftSkuIds)) {
    errors.push({ code: 'DRAFT_SKU_COVERAGE_MISMATCH', message: 'Draft does not cover every canonical SKU exactly once.', sku_ids: sourceSkuIds, attribute_ids: [] });
  }
  if (input.category_decision.status !== 'decided' || input.attribute_mapping.status !== 'completed') {
    errors.push({ code: 'UPSTREAM_NOT_PUBLISHABLE', message: 'Category decision and attribute mapping must be fully completed.', sku_ids: [], attribute_ids: [] });
  }
  const publishReady = errors.length === 0 && draft.status === 'completed';
  const v2: OzonProductDraftV2 = {
    schema_version: 2,
    source_offer_id: draft.source_offer_id,
    status: errors.length > 0 ? 'blocked' : draft.status === 'needs_review' ? 'needs_review' : 'draft_complete',
    publish_readiness: publishReady ? 'ready' : 'not_ready',
    category_snapshot_sha256: Object.fromEntries(input.category_attributes.map((group) => [
      group.group_ids.join(','), sha256Json(group.attributes_schema),
    ])),
    items: draft.items.map((item) => ({ ...item, publish_readiness: publishReady ? 'ready' : 'not_ready' })),
    warnings: draft.warnings,
    errors,
  };
  if (context) {
    const output = await context.artifact_store.write(context.run_id, 'draft-generation', 'product-draft-v2.json', v2);
    await context.artifact_store.updateStep(context.run_id, 'draft-generation', {
      status: v2.status === 'draft_complete' ? 'succeeded' : v2.status,
      output,
      step_version: '2.0.0',
    });
  }
  return {
    ...legacy,
    ok: v2.publish_readiness === 'ready',
    data: v2,
    errors: errors.map((error) => ({ code: error.code, message: error.message, detail: error, recoverable: true })),
  };
}

export async function runDraftGeneration(
  input: RunDraftGenerationInput,
  context?: WorkflowContext,
): Promise<CommandResult<OzonProductDraftV1>> {
  try {
    if (context) {
      assertWorkflowActive(context);
      await context.artifact_store.updateStep(context.run_id, 'draft-generation', {
        status: 'running',
      });
    }
    const { draft, validation } = buildDraft(input);
    if (context) {
      const output = await context.artifact_store.write(
        context.run_id,
        'draft-generation',
        'product-draft-v1.json',
        draft,
      );
      await context.artifact_store.write(
        context.run_id,
        'draft-generation',
        'validation-v1.json',
        validation,
      );
      await context.artifact_store.updateStep(context.run_id, 'draft-generation', {
        status: draft.status === 'completed' ? 'succeeded' : draft.status,
        output,
      });
    }
    if (input.products_dir) {
      await saveOzonDraftBundle(
        { offerId: draft.source_offer_id, productsDir: input.products_dir },
        draft,
        validation,
      );
    }
    return {
      ok: draft.status !== 'blocked',
      command: 'draft.generate',
      data: draft,
      warnings: draft.warnings.map((warning) => ({
        code: warning.code,
        message: warning.message,
        detail: warning,
      })),
      errors: draft.errors.map((error) => ({
        code: error.code,
        message: error.message,
        detail: error,
        recoverable: true,
      })),
      nextActions: draft.status === 'needs_review'
        ? ['Review generated Russian copy and low-confidence attributes.']
        : [],
    };
  } catch (error) {
    if (context) {
      await context.artifact_store.updateStep(context.run_id, 'draft-generation', {
        status: 'failed',
        error_code: 'DRAFT_GENERATION_FAILED',
      });
    }
    return {
      ok: false,
      command: 'draft.generate',
      warnings: [],
      errors: [{
        code: 'DRAFT_GENERATION_FAILED',
        message: error instanceof Error ? error.message : String(error),
        recoverable: true,
      }],
      nextActions: [],
    };
  }
}

function buildDraft(input: RunDraftGenerationInput): {
  draft: OzonProductDraftV1;
  validation: OzonDraftValidationV1;
} {
  const issues: OzonDraftValidationV1['issues'] = [];
  const mapping = input.attribute_mapping;
  const contentBySku = uniqueContent(input.content, issues);
  const items: OzonDraftSkuV1[] = [];
  if (mapping.source_offer_id !== input.content.source_offer_id) {
    addIssue(issues, 'error', 'CONTENT_OFFER_ID_MISMATCH', 'Copy input belongs to another offer.');
  }
  if (mapping.status === 'blocked') {
    addIssue(issues, 'error', 'BLOCKED_ATTRIBUTE_MAPPING', 'A blocked attribute mapping cannot produce a draft.');
  } else if (mapping.status === 'needs_review') {
    addIssue(issues, 'warning', 'ATTRIBUTE_MAPPING_REQUIRES_REVIEW', 'Attribute mapping requires review.');
  }

  for (const sku of mapping.sku_attributes) {
    const copy = contentBySku.get(sku.source_sku_id);
    if (!copy) {
      addIssue(issues, 'error', 'MISSING_COPY_INPUT', 'Russian copy is missing for the SKU.', [sku.source_sku_id]);
      continue;
    }
    const definitions = resolveDefinitions(sku.group_id, input.category_attributes);
    if (!definitions) {
      addIssue(issues, 'error', 'CATEGORY_ATTRIBUTES_GROUP_MISMATCH', 'No matching category snapshot exists.', [sku.source_sku_id]);
      continue;
    }
    const attributes: OzonDraftAttributeV1[] = sku.attributes
      .filter((attribute) => !CONTENT_ATTRIBUTE_IDS.has(attribute.attribute_id))
      .map((attribute) => ({
        id: attribute.attribute_id,
        complex_id: 0,
        values: attribute.values.map((value) => ({ ...value })),
        provenance: mapProvenance(attribute.provenance),
        confidence: attribute.confidence,
        evidence: attribute.evidence.map(mapEvidence),
      }));
    addTextAttribute(4180, copy.name_ru, definitions, attributes, issues, sku.source_sku_id);
    addTextAttribute(4191, copy.description_ru, definitions, attributes, issues, sku.source_sku_id);
    addTextAttribute(
      23171,
      { ...copy.hashtags_ru, value: copy.hashtags_ru.value.join(' ') },
      definitions,
      attributes,
      issues,
      sku.source_sku_id,
    );
    validateCopy(copy, definitions, issues);
    items.push({
      source_sku_id: sku.source_sku_id,
      group_id: sku.group_id,
      description_category_id: sku.description_category_id,
      type_id: sku.type_id,
      name: copy.name_ru.value.trim(),
      attributes: attributes.sort((left, right) => left.id - right.id),
    });
  }
  for (const skuId of contentBySku.keys()) {
    if (!mapping.sku_attributes.some((sku) => sku.source_sku_id === skuId)) {
      addIssue(issues, 'error', 'UNKNOWN_COPY_SKU', 'Copy input references an unknown SKU.', [skuId]);
    }
  }
  const status = issues.some((issue) => issue.severity === 'error')
    ? 'blocked'
    : issues.length > 0
      ? 'needs_review'
      : 'completed';
  const strip = ({ severity: _severity, ...issue }: OzonDraftValidationV1['issues'][number]): OzonDraftIssueV1 => issue;
  const draft: OzonProductDraftV1 = {
    schema_version: 1,
    source_offer_id: mapping.source_offer_id,
    status,
    items,
    warnings: issues.filter((issue) => issue.severity === 'warning').map(strip),
    errors: issues.filter((issue) => issue.severity === 'error').map(strip),
  };
  return {
    draft,
    validation: {
      schema_version: 1,
      source_offer_id: mapping.source_offer_id,
      status,
      valid: status !== 'blocked',
      issues,
    },
  };
}

function uniqueContent(
  content: OzonDraftContentInputV1,
  issues: OzonDraftValidationV1['issues'],
) {
  const result = new Map<string, OzonDraftContentInputV1['sku_inputs'][number]>();
  for (const sku of content.sku_inputs) {
    if (result.has(sku.source_sku_id)) {
      addIssue(issues, 'error', 'DUPLICATE_COPY_SKU', 'Copy input contains a SKU twice.', [sku.source_sku_id]);
    } else {
      result.set(sku.source_sku_id, sku);
    }
  }
  return result;
}

function resolveDefinitions(groupId: string, groups: CategoryAttributesGroupV1[]) {
  const matches = groups.filter((group) => group.group_ids.includes(groupId));
  return matches.length === 1 ? matches[0]!.attributes_schema.attributes : null;
}

function addTextAttribute(
  id: number,
  decision: OzonDraftContentInputV1['sku_inputs'][number]['name_ru'],
  definitions: CategoryAttributesGroupV1['attributes_schema']['attributes'],
  attributes: OzonDraftAttributeV1[],
  issues: OzonDraftValidationV1['issues'],
  skuId: string,
): void {
  if (!definitions.some((definition) => definition.id === id)) return;
  const value = decision.value.trim();
  if (!value || decision.evidence.length === 0) {
    addIssue(issues, 'error', 'COPY_ATTRIBUTE_INVALID', `Copy attribute ${id} is empty or lacks evidence.`, [skuId], [id]);
    return;
  }
  attributes.push({
    id,
    complex_id: 0,
    values: [{ value }],
    provenance: 'derived',
    confidence: decision.confidence,
    evidence: decision.evidence,
  });
  if (decision.confidence === 'low') {
    addIssue(issues, 'warning', 'LOW_CONFIDENCE_COPY', `Copy attribute ${id} needs review.`, [skuId], [id]);
  }
}

function validateCopy(
  copy: OzonDraftContentInputV1['sku_inputs'][number],
  definitions: CategoryAttributesGroupV1['attributes_schema']['attributes'],
  issues: OzonDraftValidationV1['issues'],
): void {
  const sku = copy.source_sku_id;
  const name = copy.name_ru.value.trim();
  if (!hasCyrillic(name) || name.length > 200 || /[.!?,;:。，！？；：]$/u.test(name)) {
    addIssue(issues, 'error', 'RUSSIAN_NAME_INVALID', 'Russian name is missing, too long, or ends with punctuation.', [sku], [4180]);
  }
  if (definitions.some((definition) => definition.id === 4191) && !hasCyrillic(copy.description_ru.value)) {
    addIssue(issues, 'error', 'RUSSIAN_DESCRIPTION_REQUIRED', 'Description must contain Russian text.', [sku], [4191]);
  }
  if (definitions.some((definition) => definition.id === 23171)) {
    const tags = copy.hashtags_ru.value;
    const unique = new Set(tags.map((tag) => tag.toLocaleLowerCase('ru-RU')));
    if (
      tags.length < 20 || tags.length > 30 || unique.size !== tags.length ||
      tags.some((tag) => !/^#[\p{Script=Cyrillic}\p{N}_]+$/u.test(tag) || tag.length > 30)
    ) {
      addIssue(issues, 'error', 'HASHTAGS_INVALID', 'Use 20-30 unique Russian hashtags of at most 30 characters.', [sku], [23171]);
    }
  }
}

function mapProvenance(value: AttributeMappingProvenanceV1): OzonDraftAttributeV1['provenance'] {
  return value === 'agent_selected' ? 'derived' : value;
}

function mapEvidence(value: AttributeMappingEvidenceV1 | AttributeMappingEvidenceV2): OzonDraftAttributeV1['evidence'][number] {
  if ('source_path' in value) {
    return {
      source: value.source === 'agent_input' ? 'agent_reasoning' : value.source,
      field: value.source_path,
      value: value.normalized_value,
    };
  }
  return {
    source: value.source === 'agent_input' ? 'agent_reasoning' : value.source,
    field: value.field,
    value: value.value,
  };
}

function addIssue(
  issues: OzonDraftValidationV1['issues'],
  severity: 'warning' | 'error',
  code: string,
  message: string,
  skuIds: string[] = [],
  attributeIds: number[] = [],
): void {
  issues.push({ severity, code, message, sku_ids: skuIds, attribute_ids: attributeIds });
}

function hasCyrillic(value: string): boolean {
  return /[\p{Script=Cyrillic}]/u.test(value);
}
