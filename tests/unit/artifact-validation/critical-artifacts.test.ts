import { describe, expect, it } from 'vitest';
import {
  assertCriticalArtifact,
  PersistedArtifactValidationError,
  validateCriticalArtifact,
  type CriticalArtifactKind,
} from '../../../packages/artifact-validation/src/index.js';

const sha = 'a'.repeat(64);
const now = '2026-07-18T00:00:00.000Z';
const snapshot = { schema_version: 1, source: 'ozon-seller-api', captured_at: now, valid_from: now, valid_to: now, sha256: sha };

const validArtifacts: Record<CriticalArtifactKind, unknown> = {
  canonical_product_v2: {
    schema_version: 2,
    source: { platform: '1688', offer_id: 'offer-1', offer_url: 'https://detail.1688.com/offer/1.html', collected_at: now, collection_method: 'offers', detail_url: null, source_category_path_zh: [], discovery_context: { search_term: null, seed_offer_id: null } },
    product: { title_zh: '杯子', main_image: null, gallery_images: [], attributes: {}, price_tiers: [], sku_options: [] },
    skus: [{ source_sku_id: 'sku-1', raw_spec_text: '', specs: {}, unparsed_spec_segments: [], price_cny: 10, multi_price_cny: null, image: null, package: { length_cm: 10, width_cm: 10, height_cm: 10, raw_weight: 100, weight_unit: 'g', source: '1688', matched_by: 'sku_id' } }],
    sku_analysis: { has_source_skus: true, is_multi_sku: false, sku_count: 1, common_fields: {}, varying_fields: [], variant_dimensions: [], missing_fields: [], duplicate_spec_combinations: [], warnings: [] },
    validation: { status: 'valid', warnings: [], errors: [] },
  },
  category_decision_v1: {
    schema_version: 1, source_offer_id: 'offer-1', category_snapshot: snapshot,
    product_understanding: { summary_zh: '杯子', product_family_zh: '杯子', evidence: [] }, representative_sku_ids: ['sku-1'], product_structure: 'single_sku',
    category_groups: [{ group_id: 'g1', source_sku_ids: ['sku-1'], group_summary_zh: '杯子', evidence: [], selected_category: null, alternative_categories: [], confidence: 'high', rationale_zh: 'fixture' }],
    unassigned_sku_ids: [], status: 'decided', warnings: [], errors: [],
  },
  cost_pricing_v1: {
    schema_version: 1, source_offer_id: 'offer-1', status: 'completed', profile: {}, tariff_version: 'CEL-2026-effective', logistics_provider_id: 'cel', tariff_snapshot_sha256: sha, tariff_source_verification: 'needs_review', commission_snapshot_sha256: sha, fx_rate: null, resolved_packages: [], sku_pricing: [], agent_tasks: [], warnings: [], errors: [],
  },
  category_attributes_group_v1: [{
    group_ids: ['g1'], category: { description_category_id: 1, description_category_name: '杯子', type_id: 2, type_name: '杯子', category_path_zh: [] },
    attributes_schema: { schema_version: 1, source: 'ozon', language: 'ZH_HANS', ok: true, fetched_at: now, snapshot, category: {}, attributes: [], raw_response: {}, dictionary_raw_responses: {} },
  }],
  attribute_mapping_v2: {
    schema_version: 2, source_offer_id: 'offer-1', status: 'completed', weight_semantics: 'legacy-cost-base-v1',
    category_snapshot_refs: [{ group_id: 'g1', description_category_id: 1, type_id: 2, captured_at: now, valid_to: now, sha256: sha }],
    common_attributes: [], variant_attributes: [], sku_attributes: [{ source_sku_id: 'sku-1' }], agent_tasks: [], missing_required_attributes: [], unresolved_attributes: [], warnings: [], errors: [],
  },
  content_bundle_v1: { schema_version: 1, source_offer_id: 'offer-1', status: 'completed', sku_content: [], errors: [] },
  image_bundle_v1: { schema_version: 1, source_offer_id: 'offer-1', status: 'completed', assets: [], sku_images: [], generation: null, warnings: [], errors: [], agent_tasks: [] },
  publish_intent_v1: { schema_version: 1, intent_id: 'intent-1', run_id: 'run-1', store_id: 'store-1', offer_id: 'offer-1', item_hash: sha, status: 'prepared', task_id: null, product_id: null, reconciliation_checks: 0, last_reconciliation_at: null, created_at: now, updated_at: now },
  store_publishing_consent_v1: { schema_version: 1, consent_id: 'consent-1', store_id: 'store-1', enabled: true, actor: 'owner', source: 'setup_cli', created_at: now, revoked_at: null, profile_hash: sha, policy_version: 'automatic-publish-v1' },
  publish_authorization_v1: { schema_version: 1, authorization_id: 'authorization-1', consent_id: 'consent-1', run_id: 'run-1', store_id: 'store-1', profile_hash: sha, draft_sha256: sha, created_at: now },
};

describe('critical persisted artifact runtime validation', () => {
  it('accepts every supported contract at its persistence boundary', () => {
    for (const [kind, artifact] of Object.entries(validArtifacts) as Array<[CriticalArtifactKind, unknown]>) {
      expect(validateCriticalArtifact(kind, artifact), kind).toMatchObject({ ok: true, errors: [] });
    }
  });

  it('returns a structured schema error for every missing required root field', () => {
    for (const [kind, artifact] of Object.entries(validArtifacts) as Array<[CriticalArtifactKind, unknown]>) {
      const damaged = structuredClone(artifact) as Record<string, unknown> | unknown[];
      if (Array.isArray(damaged)) damaged.length = 0;
      else delete damaged[Object.keys(damaged).find((key) => key !== 'schema_version')!];
      const result = validateCriticalArtifact(kind, damaged);
      expect(result.ok, kind).toBe(false);
      if (!result.ok) expect(result.code, kind).toMatch(/_SCHEMA_INVALID$/u);
    }
  });

  it('rejects unsupported persisted contract versions before field access', () => {
    for (const kind of Object.keys(validArtifacts) as CriticalArtifactKind[]) {
      if (kind === 'category_attributes_group_v1') continue;
      const damaged = { ...(validArtifacts[kind] as Record<string, unknown>), schema_version: 0 };
      const result = validateCriticalArtifact(kind, damaged);
      expect(result.ok, kind).toBe(false);
      if (!result.ok) expect(result.code, kind).toMatch(/_CONTRACT_UNSUPPORTED$/u);
    }
  });

  it('throws only the structured persistence error from assert boundaries', () => {
    try {
      assertCriticalArtifact('publish_intent_v1', { schema_version: 1 });
      throw new Error('expected validation failure');
    } catch (error) {
      expect(error).toBeInstanceOf(PersistedArtifactValidationError);
      expect(error).toMatchObject({ code: 'PUBLISH_INTENT_SCHEMA_INVALID', artifact_kind: 'publish_intent_v1' });
    }
  });
});
