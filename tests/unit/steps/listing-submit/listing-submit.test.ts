import { describe, expect, it } from 'vitest';
import { runListingSubmit, stableHash } from '../../../../packages/steps/listing-submit/src/index.js';
import type {
  ListingDraftV2,
  OzonPublishResultV1,
  PreflightReportV1,
  PublishAuthorizationV1,
  SellerImportTransportV1,
  StorePublishingConsentV1,
  StorePublishProfileV1,
} from '../../../../packages/contracts/src/index.js';
import type { PublishReliabilityStore } from '../../../../packages/job-store/src/index.js';

const item = (offer_id: string) => ({
  offer_id,
  name: 'Термокружка',
  price: '20.00',
  description_category_id: 1,
  type_id: 2,
  weight: 600,
  depth: 200,
  width: 100,
  height: 100,
  dimension_unit: 'mm' as const,
  weight_unit: 'g' as const,
  images: ['https://img.test/a.jpg'],
  primary_image: 'https://img.test/a.jpg',
  attributes: [],
  complex_attributes: [] as [],
  currency_code: 'CNY' as const,
});

const draft: ListingDraftV2 = {
  schema_version: 2,
  source_offer_id: '1688',
  status: 'draft_complete',
  generated_at: '2026-07-17T00:00:00.000Z',
  weight_semantics: 'legacy-cost-base-v1',
  artifact_hashes: {
    canonical_product_sha256: '1'.repeat(64),
    category_decision_sha256: '2'.repeat(64),
    cost_pricing_sha256: '3'.repeat(64),
    category_attributes_sha256: '4'.repeat(64),
    attribute_mapping_sha256: '5'.repeat(64),
    content_bundle_sha256: '6'.repeat(64),
    image_bundle_sha256: '7'.repeat(64),
  },
  category_tree_snapshot: {
    schema_version: 1,
    source: 'ozon-seller-api',
    captured_at: '2026-07-17T00:00:00.000Z',
    valid_from: '2026-07-17T00:00:00.000Z',
    valid_to: '2026-07-24T00:00:00.000Z',
    sha256: '8'.repeat(64),
  },
  attribute_snapshot_refs: [{
    group_ids: ['group'],
    description_category_id: 1,
    type_id: 2,
    captured_at: '2026-07-17T00:00:00.000Z',
    valid_from: '2026-07-17T00:00:00.000Z',
    valid_to: '2026-07-24T00:00:00.000Z',
    sha256: '9'.repeat(64),
  }],
  sku_bindings: [
    { source_sku_id: 'sku-a', offer_id: 'a' },
    { source_sku_id: 'sku-b', offer_id: 'b' },
  ],
  warnings: [],
  errors: [],
  items: ['a', 'b'].map(item),
};

const profile: StorePublishProfileV1 = {
  store_id: '5',
  publishing: { enabled: true },
  credentials: { client_id_env: 'X', api_key_env: 'Y' },
  polling: { timeout_ms: 100, interval_ms: 0, max_recoverable_retries: 2 },
};

describe('listing-submit', () => {
  it('submits draft items, polls, and records only API-confirmed product IDs', async () => {
    const transport: SellerImportTransportV1 = { submit: async () => ({ task_id: 'task-1' }), getImportInfo: async () => ({ complete: true, items: [{ offer_id: 'a', status: 'imported' }, { offer_id: 'b', status: 'imported' }] }), getProductsByOfferIds: async () => [{ offer_id: 'a', product_id: 11 }, { offer_id: 'b', product_id: 12 }] };
    const result = await runListingSubmit(input(transport));
    expect(result).toMatchObject({ ok: true, data: { status: 'completed', task_ids: ['task-1'], sku_results: [{ offer_id: 'a', product_id: 11 }, { offer_id: 'b', product_id: 12 }] } });
  });

  it('retries only a failed SKU at most twice and preserves successful SKUs', async () => {
    const submissions: string[][] = []; let calls = 0;
    const transport: SellerImportTransportV1 = { submit: async (items) => { submissions.push(items.map((entry) => entry.offer_id)); return { task_id: `task-${submissions.length}` }; }, getImportInfo: async () => { calls += 1; return calls === 1 ? { complete: true, items: [{ offer_id: 'a', status: 'imported' }, { offer_id: 'b', status: 'failed', errors: ['temporary'] }] } : { complete: true, items: [{ offer_id: 'b', status: 'imported' }] }; }, getProductsByOfferIds: async () => [{ offer_id: 'a', product_id: 11 }, { offer_id: 'b', product_id: 12 }] };
    const result = await runListingSubmit(input(transport));
    expect(submissions).toEqual([['a', 'b'], ['b']]); expect(result.data?.status).toBe('completed'); expect(result.data?.sku_results.find((entry) => entry.offer_id === 'b')?.retry_count).toBe(1);
  });

  it('blocks a non-publish-ready draft without calling the transport', async () => {
    const blocked = { ...draft, status: 'blocked' as const }; const transport: SellerImportTransportV1 = { submit: async () => { throw new Error('must not submit'); }, getImportInfo: async () => { throw new Error('must not poll'); }, getProductsByOfferIds: async () => [] };
    const result = await runListingSubmit(input(transport, blocked));
    expect(result).toMatchObject({ ok: false, data: { status: 'blocked', errors: ['DRAFT_NOT_PUBLISH_READY'] } });
  });

  it('blocks a revoked or cross-store consent before calling the transport', async () => {
    let submissions = 0;
    const transport: SellerImportTransportV1 = { submit: async () => { submissions += 1; return { task_id: 'must-not-submit' }; }, getImportInfo: async () => ({ complete: true, items: [] }), getProductsByOfferIds: async () => [] };
    const base = input(transport);
    const revoked = await runListingSubmit({ ...base, consent: { ...base.consent, enabled: false, revoked_at: '2026-07-18T00:00:00.000Z' } });
    const otherStore = await runListingSubmit({ ...base, consent: { ...base.consent, store_id: 'other-store' } });
    expect(revoked.data?.errors).toContain('AUTHORIZATION_BINDING_INVALID');
    expect(otherStore.data?.errors).toContain('AUTHORIZATION_BINDING_INVALID');
    expect(submissions).toBe(0);
  });

  it('invalidates an execution authorization when the draft changes', async () => {
    const transport: SellerImportTransportV1 = { submit: async () => { throw new Error('must not submit'); }, getImportInfo: async () => ({ complete: true, items: [] }), getProductsByOfferIds: async () => [] };
    const original = input(transport);
    const changed = { ...draft, items: draft.items.map((entry, index) => index === 0 ? { ...entry, price: '21.00' } : entry) };
    const result = await runListingSubmit({ ...original, draft: changed });
    expect(result.data?.errors).toContain('PREFLIGHT_BINDING_INVALID');
  });

  it('resumes an unfinished task by polling it before making another submission', async () => {
    const first: SellerImportTransportV1 = { submit: async () => ({ task_id: 'task-timeout' }), getImportInfo: async () => ({ complete: false, items: [] }), getProductsByOfferIds: async () => [] };
    const timedOut = await runListingSubmit({ ...input(first), profile: { ...profile, polling: { ...profile.polling, timeout_ms: 0 } } });
    let submitted = 0; let polled = 0;
    const resumed: SellerImportTransportV1 = { submit: async () => { submitted += 1; return { task_id: 'unexpected' }; }, getImportInfo: async () => { polled += 1; return { complete: true, items: [{ offer_id: 'a', status: 'imported' }, { offer_id: 'b', status: 'imported' }] }; }, getProductsByOfferIds: async () => [{ offer_id: 'a', product_id: 1 }, { offer_id: 'b', product_id: 2 }] };
    const result = await runListingSubmit(input(resumed, draft, timedOut.data!));
    expect(polled).toBeGreaterThan(0); expect(submitted).toBe(0); expect(result.data?.status).toBe('completed');
  });

  it('returns a structured error for a corrupted persisted publish intent', async () => {
    const transport: SellerImportTransportV1 = {
      submit: async () => { throw new Error('must not submit'); },
      getImportInfo: async () => { throw new Error('must not poll'); },
      getProductsByOfferIds: async () => [],
    };
    const reliability_store = {
      listUncertainIntents: async () => [{ schema_version: 1, intent_id: 'damaged' }],
    } as unknown as PublishReliabilityStore;
    const result = await runListingSubmit({ ...input(transport), reliability_store });
    expect(result).toMatchObject({
      ok: false,
      errors: [{ code: 'PUBLISH_INTENT_SCHEMA_INVALID' }],
    });
  });
});

function input(
  transport: SellerImportTransportV1,
  selectedDraft: ListingDraftV2 = draft,
  previous?: OzonPublishResultV1,
) {
  const run_id = 'run-1';
  const draft_sha256 = stableHash(selectedDraft.items);
  const preflight: PreflightReportV1 = {
    schema_version: 1,
    run_id,
    store_id: profile.store_id,
    draft_sha256,
    checked_at: '2026-07-17T00:00:00.000Z',
    status: 'passed',
    checks: [],
  };
  const consent: StorePublishingConsentV1 = {
    schema_version: 1,
    consent_id: 'consent-1',
    store_id: profile.store_id,
    enabled: true,
    actor: 'test',
    source: 'setup_cli',
    created_at: '2026-07-17T00:00:00.000Z',
    revoked_at: null,
    profile_hash: 'a'.repeat(64),
    policy_version: 'automatic-publish-v1',
  };
  const authorization: PublishAuthorizationV1 = {
    schema_version: 1,
    authorization_id: 'authorization-1',
    consent_id: consent.consent_id,
    run_id,
    store_id: profile.store_id,
    profile_hash: 'a'.repeat(64),
    draft_sha256,
    created_at: '2026-07-17T00:00:00.000Z',
  };
  return { draft: selectedDraft, profile, transport, previous, run_id, preflight, consent, authorization };
}
