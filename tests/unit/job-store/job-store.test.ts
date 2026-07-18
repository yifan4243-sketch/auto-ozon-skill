import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AuthorizationRecordV1,
  ListingDraftV2,
  OutboxRecordV1,
  PreflightReportV1,
  PublishIntentV1,
  SellerImportTransportV1,
} from '../../../packages/contracts/src/index.js';
import { SqliteJobStore } from '../../../packages/job-store/src/index.js';
import { runListingSubmit, stableHash } from '../../../packages/steps/listing-submit/src/index.js';

const directories: string[] = [];
const stores: SqliteJobStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map((item) => fs.rm(item, { recursive: true, force: true })));
});

describe('SQLite publish reliability store', () => {
  it('atomically persists a unique intent and outbox and supports reconciliation', async () => {
    const store = await newStore();
    const { intent, outbox } = records();
    store.prepareIntents([{ intent, outbox }, { intent, outbox }]);
    expect(store.getIntent('500', 'offer-a', 'hash-a')).toMatchObject({ status: 'prepared', reconciliation_checks: 0, last_reconciliation_at: null });
    store.markSubmitted([intent.intent_id], 'task-1');
    expect(store.getIntent('500', 'offer-a', 'hash-a')).toMatchObject({ status: 'submitted', task_id: 'task-1' });
    store.markReconciled(intent.intent_id, 'succeeded', 42);
    expect(store.getIntent('500', 'offer-a', 'hash-a')).toMatchObject({ status: 'succeeded', product_id: 42 });
    expect(store.countSucceededSince('500', '2026-01-01T00:00:00.000Z')).toBe(1);
  });

  it('prevents cross-run duplicate submission for a succeeded store+offer+hash', async () => {
    const store = await newStore();
    let submissions = 0;
    const transport: SellerImportTransportV1 = {
      submit: async () => { submissions += 1; return { task_id: 'task-1' }; },
      getImportInfo: async () => ({ complete: true, items: [{ offer_id: 'offer-a', status: 'imported' }] }),
      getProductsByOfferIds: async () => [{ offer_id: 'offer-a', product_id: 42 }],
    };
    const firstInput = submitInput('run-1', transport, store);
    const secondInput = submitInput('run-2', transport, store);
    store.createAuthorization(firstInput.authorization);
    store.createAuthorization(secondInput.authorization);
    const first = await runListingSubmit(firstInput);
    const second = await runListingSubmit(secondInput);
    expect(first.data?.status).toBe('completed');
    expect(second.data?.sku_results[0]).toMatchObject({ status: 'skipped', product_id: 42 });
    expect(submissions).toBe(1);
  });

  it('does not resubmit an uncertain prepared intent after a crash', async () => {
    const store = await newStore();
    const itemHash = hashForDraftItem(draft.items[0]!);
    const now = new Date().toISOString();
    const intent: PublishIntentV1 = { schema_version: 1, intent_id: 'uncertain', run_id: 'old', store_id: '500', offer_id: 'offer-a', item_hash: itemHash,
      status: 'prepared', task_id: null, product_id: null, reconciliation_checks: 0, last_reconciliation_at: null, created_at: now, updated_at: now };
    const outbox: OutboxRecordV1 = { schema_version: 1, outbox_id: 'outbox-uncertain', intent_id: intent.intent_id, status: 'pending', attempts: 0, last_error_code: null, created_at: now, updated_at: now };
    store.prepareIntents([{ intent, outbox }]);
    let submissions = 0;
    const transport: SellerImportTransportV1 = { submit: async () => { submissions += 1; return { task_id: 'duplicate' }; }, getImportInfo: async () => ({ complete: false, items: [] }), getProductsByOfferIds: async () => [] };
    const input = submitInput('new', transport, store);
    store.createAuthorization(input.authorization);
    const result = await runListingSubmit(input);
    expect(result.data?.status).toBe('polling_timeout');
    expect(result.data?.warnings).toContain('PUBLISH_RECONCILIATION_REQUIRED');
    expect(submissions).toBe(0);
  });
});

async function newStore(): Promise<SqliteJobStore> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'job-store-'));
  directories.push(directory);
  const store = new SqliteJobStore(path.join(directory, 'state.sqlite'));
  stores.push(store);
  return store;
}

function records(): { intent: PublishIntentV1; outbox: OutboxRecordV1 } {
  const now = '2026-07-17T00:00:00.000Z';
  const intent: PublishIntentV1 = { schema_version: 1, intent_id: 'intent-a', run_id: 'run-a', store_id: '500', offer_id: 'offer-a', item_hash: 'hash-a', status: 'prepared', task_id: null, product_id: null, reconciliation_checks: 0, last_reconciliation_at: null, created_at: now, updated_at: now };
  return { intent, outbox: { schema_version: 1, outbox_id: 'outbox-a', intent_id: intent.intent_id, status: 'pending', attempts: 0, last_error_code: null, created_at: now, updated_at: now } };
}

const profile = { store_id: '500', publishing: { enabled: true }, credentials: { client_id_env: 'X', api_key_env: 'Y' }, polling: { timeout_ms: 10, interval_ms: 0, max_recoverable_retries: 2 as const } };
const draft: ListingDraftV2 = {
  schema_version: 2,
  source_offer_id: '1688',
  status: 'draft_complete',
  generated_at: '2026-07-17T00:00:00.000Z',
  weight_semantics: 'legacy-cost-base-v1',
  artifact_hashes: {
    canonical_product_sha256: '1'.repeat(64), category_decision_sha256: '2'.repeat(64),
    cost_pricing_sha256: '3'.repeat(64), category_attributes_sha256: '4'.repeat(64),
    attribute_mapping_sha256: '5'.repeat(64), content_bundle_sha256: '6'.repeat(64), image_bundle_sha256: '7'.repeat(64),
  },
  category_tree_snapshot: { schema_version: 1, source: 'ozon-seller-api', captured_at: '2026-07-17T00:00:00.000Z', valid_from: '2026-07-17T00:00:00.000Z', valid_to: '2026-07-24T00:00:00.000Z', sha256: '8'.repeat(64) },
  attribute_snapshot_refs: [{ group_ids: ['group'], description_category_id: 1, type_id: 2, captured_at: '2026-07-17T00:00:00.000Z', valid_from: '2026-07-17T00:00:00.000Z', valid_to: '2026-07-24T00:00:00.000Z', sha256: '9'.repeat(64) }],
  sku_bindings: [{ source_sku_id: 'sku-a', offer_id: 'offer-a' }],
  warnings: [], errors: [],
  items: [{ offer_id: 'offer-a', name: 'Товар', price: '20.00', description_category_id: 1, type_id: 2, weight: 600, depth: 200, width: 100, height: 100, dimension_unit: 'mm', weight_unit: 'g', images: ['https://img.test/a.jpg'], primary_image: 'https://img.test/a.jpg', attributes: [], complex_attributes: [], currency_code: 'CNY' }],
};

function submitInput(run_id: string, transport: SellerImportTransportV1, reliability_store: SqliteJobStore) {
  const draft_sha256 = stableHash(draft.items);
  const preflight: PreflightReportV1 = { schema_version: 1, run_id, store_id: profile.store_id, draft_sha256, checked_at: '2026-07-17T00:00:00.000Z', status: 'passed', checks: [] };
  const authorization: AuthorizationRecordV1 = { schema_version: 1, authorization_id: `authorization-${run_id}`, run_id, store_id: profile.store_id, source: 'enabled_store_profile', automation_level: 'automatic', policy_version: 'automatic-publish-v1', profile_hash: 'a'.repeat(64), draft_sha256, authorized_at: '2026-07-17T00:00:00.000Z' };
  return { draft, profile, transport, run_id, reliability_store, preflight, authorization };
}

function hashForDraftItem(value: unknown): string {
  const stable = (item: unknown): string => item === null || typeof item !== 'object' ? JSON.stringify(item)
    : Array.isArray(item) ? `[${item.map(stable).join(',')}]`
      : `{${Object.keys(item as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stable((item as Record<string, unknown>)[key])}`).join(',')}}`;
  return createHash('sha256').update(stable(value)).digest('hex');
}
