import type {
  AttributeMappingV2,
  CanonicalProductV2,
  CategoryAttributesGroupV1,
  CategoryDecisionV1,
  ContentBundleV1,
  CostPricingV1,
  ImageBundleV1,
  PublishAuthorizationV1,
  PublishIntentV1,
  StorePublishingConsentV1,
} from '@auto-ozon/contracts';
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';

export interface CriticalArtifactTypeMap {
  canonical_product_v2: CanonicalProductV2;
  category_decision_v1: CategoryDecisionV1;
  cost_pricing_v1: CostPricingV1;
  category_attributes_group_v1: CategoryAttributesGroupV1[];
  attribute_mapping_v2: AttributeMappingV2;
  content_bundle_v1: ContentBundleV1;
  image_bundle_v1: ImageBundleV1;
  publish_intent_v1: PublishIntentV1;
  store_publishing_consent_v1: StorePublishingConsentV1;
  publish_authorization_v1: PublishAuthorizationV1;
}

export type CriticalArtifactKind = keyof CriticalArtifactTypeMap;
export type CriticalArtifactValidation<K extends CriticalArtifactKind> =
  | { ok: true; value: CriticalArtifactTypeMap[K]; errors: [] }
  | { ok: false; code: string; errors: string[] };

const validators = new Map<CriticalArtifactKind, ValidateFunction>();
const ajv = new Ajv2020({ allErrors: true, strict: false });

/** Runtime boundary for persisted workflow artifacts and database intents. */
export function validateCriticalArtifact<K extends CriticalArtifactKind>(
  kind: K,
  value: unknown,
): CriticalArtifactValidation<K> {
  const expectedVersion = expectedVersions[kind];
  if (expectedVersion !== null && isRecord(value) && typeof value.schema_version === 'number'
    && value.schema_version !== expectedVersion) {
    return {
      ok: false,
      code: `${codePrefixes[kind]}_CONTRACT_UNSUPPORTED`,
      errors: [`Expected schema_version ${expectedVersion}; received ${value.schema_version}.`],
    };
  }
  let validator = validators.get(kind);
  if (!validator) {
    validator = ajv.compile(schemas[kind]);
    validators.set(kind, validator);
  }
  if (validator(value) !== true) {
    return {
      ok: false,
      code: `${codePrefixes[kind]}_SCHEMA_INVALID`,
      errors: formatErrors(validator.errors),
    };
  }
  return { ok: true, value: value as CriticalArtifactTypeMap[K], errors: [] };
}

export class PersistedArtifactValidationError extends Error {
  constructor(
    readonly code: string,
    readonly artifact_kind: string,
    readonly validation_errors: string[],
  ) {
    super(`${artifact_kind} failed runtime validation: ${validation_errors.join('; ')}`);
    this.name = 'PersistedArtifactValidationError';
  }
}

export function assertCriticalArtifact<K extends CriticalArtifactKind>(
  kind: K,
  value: unknown,
): CriticalArtifactTypeMap[K] {
  const result = validateCriticalArtifact(kind, value);
  if (!result.ok) throw new PersistedArtifactValidationError(result.code, kind, result.errors);
  return result.value;
}

const expectedVersions: Record<CriticalArtifactKind, number | null> = {
  canonical_product_v2: 2,
  category_decision_v1: 1,
  cost_pricing_v1: 1,
  category_attributes_group_v1: null,
  attribute_mapping_v2: 2,
  content_bundle_v1: 1,
  image_bundle_v1: 1,
  publish_intent_v1: 1,
  store_publishing_consent_v1: 1,
  publish_authorization_v1: 1,
};

const codePrefixes: Record<CriticalArtifactKind, string> = {
  canonical_product_v2: 'CANONICAL_PRODUCT',
  category_decision_v1: 'CATEGORY_DECISION',
  cost_pricing_v1: 'COST_PRICING',
  category_attributes_group_v1: 'CATEGORY_ATTRIBUTES',
  attribute_mapping_v2: 'ATTRIBUTE_MAPPING',
  content_bundle_v1: 'CONTENT_BUNDLE',
  image_bundle_v1: 'IMAGE_BUNDLE',
  publish_intent_v1: 'PUBLISH_INTENT',
  store_publishing_consent_v1: 'STORE_PUBLISHING_CONSENT',
  publish_authorization_v1: 'PUBLISH_AUTHORIZATION',
};

const nonEmptyString = { type: 'string', minLength: 1 } as const;
const nullableString = { type: ['string', 'null'] } as const;
const positiveInteger = { type: 'integer', minimum: 1 } as const;
const sha256 = { type: 'string', pattern: '^[a-f0-9]{64}$' } as const;
const issueArray = { type: 'array' } as const;

const snapshot = {
  type: 'object',
  required: ['schema_version', 'source', 'captured_at', 'valid_from', 'valid_to', 'sha256'],
  properties: {
    schema_version: { const: 1 }, source: { const: 'ozon-seller-api' },
    captured_at: nonEmptyString, valid_from: nonEmptyString, valid_to: nonEmptyString, sha256,
  },
} as const;

const schemas: Record<CriticalArtifactKind, object> = {
  canonical_product_v2: {
    type: 'object',
    required: ['schema_version', 'source', 'product', 'skus', 'sku_analysis', 'validation'],
    properties: {
      schema_version: { const: 2 },
      source: {
        type: 'object', required: ['platform', 'offer_id', 'offer_url', 'collected_at', 'collection_method', 'detail_url', 'source_category_path_zh', 'discovery_context'],
        properties: { platform: { const: '1688' }, offer_id: nonEmptyString, offer_url: nonEmptyString, collected_at: nonEmptyString, collection_method: nonEmptyString, detail_url: nullableString, source_category_path_zh: { type: 'array' }, discovery_context: { type: 'object' } },
      },
      product: { type: 'object', required: ['title_zh', 'main_image', 'gallery_images', 'attributes', 'price_tiers', 'sku_options'], properties: { title_zh: nonEmptyString, main_image: nullableString, gallery_images: { type: 'array' }, attributes: { type: 'object' }, price_tiers: { type: 'array' }, sku_options: { type: 'array' } } },
      skus: { type: 'array', minItems: 1, items: { type: 'object', required: ['source_sku_id', 'raw_spec_text', 'specs', 'unparsed_spec_segments', 'price_cny', 'multi_price_cny', 'image', 'package'], properties: { source_sku_id: nonEmptyString, raw_spec_text: { type: 'string' }, specs: { type: 'object' }, unparsed_spec_segments: { type: 'array' }, price_cny: { type: ['number', 'null'] }, multi_price_cny: { type: ['number', 'null'] }, image: nullableString, package: { type: 'object', required: ['length_cm', 'width_cm', 'height_cm', 'raw_weight', 'weight_unit', 'source', 'matched_by'] } } } },
      sku_analysis: { type: 'object', required: ['has_source_skus', 'is_multi_sku', 'sku_count', 'common_fields', 'varying_fields', 'variant_dimensions', 'missing_fields', 'duplicate_spec_combinations', 'warnings'] },
      validation: { type: 'object', required: ['status', 'warnings', 'errors'], properties: { status: { enum: ['valid', 'warning', 'needs_review', 'blocked'] }, warnings: issueArray, errors: issueArray } },
    },
  },
  category_decision_v1: {
    type: 'object', required: ['schema_version', 'source_offer_id', 'product_understanding', 'representative_sku_ids', 'product_structure', 'category_groups', 'unassigned_sku_ids', 'status', 'warnings', 'errors'],
    properties: {
      schema_version: { const: 1 }, source_offer_id: nonEmptyString, category_snapshot: snapshot,
      product_understanding: { type: 'object', required: ['summary_zh', 'product_family_zh', 'evidence'] }, representative_sku_ids: { type: 'array' },
      product_structure: { enum: ['single_sku', 'normal_variants', 'mixed_product', 'unclear'] },
      category_groups: { type: 'array', minItems: 1, items: { type: 'object', required: ['group_id', 'source_sku_ids', 'group_summary_zh', 'evidence', 'selected_category', 'alternative_categories', 'confidence', 'rationale_zh'] } },
      unassigned_sku_ids: { type: 'array' }, status: { enum: ['decided', 'needs_review', 'blocked'] }, warnings: issueArray, errors: issueArray,
    },
  },
  cost_pricing_v1: {
    type: 'object', required: ['schema_version', 'source_offer_id', 'status', 'profile', 'tariff_version', 'logistics_provider_id', 'tariff_snapshot_sha256', 'tariff_source_verification', 'commission_snapshot_sha256', 'fx_rate', 'resolved_packages', 'sku_pricing', 'agent_tasks', 'warnings', 'errors'],
    properties: { schema_version: { const: 1 }, source_offer_id: nonEmptyString, status: { enum: ['completed', 'needs_agent', 'blocked'] }, profile: { type: 'object' }, tariff_version: nonEmptyString, logistics_provider_id: nonEmptyString, tariff_snapshot_sha256: sha256, tariff_source_verification: { const: 'needs_review' }, commission_snapshot_sha256: sha256, fx_rate: { type: ['object', 'null'] }, resolved_packages: { type: 'array' }, sku_pricing: { type: 'array' }, agent_tasks: { type: 'array' }, warnings: issueArray, errors: issueArray },
  },
  category_attributes_group_v1: {
    type: 'array', minItems: 1, items: {
      type: 'object', required: ['group_ids', 'category', 'attributes_schema'],
      properties: {
        group_ids: { type: 'array', minItems: 1, items: nonEmptyString },
        category: { type: 'object', required: ['description_category_id', 'description_category_name', 'type_id', 'type_name', 'category_path_zh'], properties: { description_category_id: positiveInteger, type_id: positiveInteger } },
        attributes_schema: { type: 'object', required: ['schema_version', 'source', 'language', 'ok', 'fetched_at', 'snapshot', 'category', 'attributes', 'raw_response', 'dictionary_raw_responses'], properties: { schema_version: { const: 1 }, source: { const: 'ozon' }, language: { const: 'ZH_HANS' }, ok: { type: 'boolean' }, fetched_at: nonEmptyString, snapshot, category: { type: 'object' }, attributes: { type: 'array' }, dictionary_raw_responses: { type: 'object' } } },
      },
    },
  },
  attribute_mapping_v2: {
    type: 'object', required: ['schema_version', 'source_offer_id', 'status', 'weight_semantics', 'category_snapshot_refs', 'common_attributes', 'variant_attributes', 'sku_attributes', 'agent_tasks', 'missing_required_attributes', 'unresolved_attributes', 'warnings', 'errors'],
    properties: {
      schema_version: { const: 2 }, source_offer_id: nonEmptyString, status: { enum: ['completed', 'needs_review', 'blocked'] }, weight_semantics: nonEmptyString,
      category_snapshot_refs: { type: 'array', minItems: 1, items: { type: 'object', required: ['group_id', 'description_category_id', 'type_id', 'captured_at', 'valid_to', 'sha256'], properties: { group_id: nonEmptyString, description_category_id: positiveInteger, type_id: positiveInteger, captured_at: nonEmptyString, valid_to: nonEmptyString, sha256 } } },
      common_attributes: { type: 'array' }, variant_attributes: { type: 'array' }, sku_attributes: { type: 'array', minItems: 1 }, agent_tasks: { type: 'array' }, missing_required_attributes: { type: 'array' }, unresolved_attributes: { type: 'array' }, warnings: issueArray, errors: issueArray,
    },
  },
  content_bundle_v1: {
    type: 'object', required: ['schema_version', 'source_offer_id', 'status', 'sku_content', 'errors'],
    properties: { schema_version: { const: 1 }, source_offer_id: nonEmptyString, status: { enum: ['completed', 'needs_review', 'blocked'] }, sku_content: { type: 'array', items: { type: 'object', required: ['source_sku_id', 'title_ru', 'description_ru', 'hashtags_ru', 'confidence', 'evidence_refs', 'claims'] } }, errors: { type: 'array' } },
  },
  image_bundle_v1: {
    type: 'object', required: ['schema_version', 'source_offer_id', 'status', 'assets', 'sku_images', 'generation', 'warnings', 'errors', 'agent_tasks'],
    properties: { schema_version: { const: 1 }, source_offer_id: nonEmptyString, status: { enum: ['completed', 'needs_review', 'blocked'] }, assets: { type: 'array', items: { type: 'object', required: ['url', 'url_sha256', 'content_sha256', 'byte_size', 'media_type', 'width_px', 'height_px', 'aspect_ratio', 'source', 'role', 'source_sku_ids', 'generation_call_id', 'text_review'] } }, sku_images: { type: 'array', items: { type: 'object', required: ['source_sku_id', 'primary_image', 'images'] } }, generation: { type: ['object', 'null'] }, warnings: issueArray, errors: issueArray, agent_tasks: { type: 'array' } },
  },
  publish_intent_v1: {
    type: 'object', required: ['schema_version', 'intent_id', 'run_id', 'store_id', 'offer_id', 'item_hash', 'status', 'task_id', 'product_id', 'reconciliation_checks', 'last_reconciliation_at', 'created_at', 'updated_at'],
    properties: { schema_version: { const: 1 }, intent_id: nonEmptyString, run_id: nonEmptyString, store_id: nonEmptyString, offer_id: nonEmptyString, item_hash: sha256, status: { enum: ['prepared', 'submitted', 'polling', 'succeeded', 'failed', 'unknown'] }, task_id: nullableString, product_id: { type: ['integer', 'null'], minimum: 1 }, reconciliation_checks: { type: 'integer', minimum: 0 }, last_reconciliation_at: nullableString, created_at: nonEmptyString, updated_at: nonEmptyString },
  },
  store_publishing_consent_v1: {
    type: 'object', required: ['schema_version', 'consent_id', 'store_id', 'enabled', 'actor', 'source', 'created_at', 'revoked_at', 'profile_hash', 'policy_version'],
    properties: { schema_version: { const: 1 }, consent_id: nonEmptyString, store_id: nonEmptyString, enabled: { type: 'boolean' }, actor: nonEmptyString, source: { enum: ['setup_cli', 'local_review_console'] }, created_at: nonEmptyString, revoked_at: nullableString, profile_hash: sha256, policy_version: nonEmptyString },
  },
  publish_authorization_v1: {
    type: 'object', required: ['schema_version', 'authorization_id', 'consent_id', 'run_id', 'store_id', 'profile_hash', 'draft_sha256', 'created_at'],
    properties: { schema_version: { const: 1 }, authorization_id: nonEmptyString, consent_id: nonEmptyString, run_id: nonEmptyString, store_id: nonEmptyString, profile_hash: sha256, draft_sha256: sha256, created_at: nonEmptyString },
  },
};

function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`.trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
