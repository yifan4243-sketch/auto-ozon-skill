import { describe, expect, it } from 'vitest';
import {
  WORKFLOW_STEP_NAMES,
  type ListingBatchResultV1,
  type OutboxRecordV1,
  type PublishAuthorizationV1,
  type PublishIntentV1,
  type StorePublishingConsentV1,
  type WorkflowRunManifestV2,
} from '../../../packages/contracts/src/index.js';
import {
  POSTGRES_JOB_STORE_SCHEMA_V1,
  PostgresJobStore,
  type PostgresQueryClientV1,
} from '../../../packages/job-store/src/index.js';
import { PostgresReviewConsoleStateReader } from '../../../packages/control-plane/src/postgres-review-state.js';

describe('PostgreSQL Job Store', () => {
  it('initializes consent, authorization foreign key, reconciliation and mirror schema', async () => {
    const client = new FakeClient();
    await new PostgresJobStore(client).migrate();
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.sql).toBe(POSTGRES_JOB_STORE_SCHEMA_V1);
    expect(client.calls[0]!.sql).toContain('REFERENCES store_publishing_consents(consent_id)');
    expect(client.calls[0]!.sql).toContain('reconciliation_checks');
    expect(client.calls[0]!.sql).toContain('workflow_step_attempts');
  });

  it('keeps consent and per-draft authorization linked without returning secrets', async () => {
    const consent = consentRecord();
    const client = new FakeClient((sql) => sql.includes('SELECT payload_json')
      ? { rows: [{ payload_json: JSON.stringify(consent) }] }
      : { rows: [] });
    const store = new PostgresJobStore(client);
    await store.createConsent(consent);
    expect(await store.getActiveConsent('525')).toEqual(consent);
    const authorization: PublishAuthorizationV1 = {
      schema_version: 1, authorization_id: 'authorization-1', consent_id: consent.consent_id,
      run_id: 'run-1', store_id: '525', profile_hash: consent.profile_hash,
      draft_sha256: 'b'.repeat(64), created_at: '2026-07-18T00:01:00.000Z',
    };
    await store.createAuthorization(authorization);
    const insert = client.calls.find((call) => call.sql.includes('INSERT INTO authorization_records'))!;
    expect(insert.values?.slice(0, 4)).toEqual(['authorization-1', 'consent-1', 'run-1', '525']);
    expect(JSON.stringify(client.calls)).not.toContain('api-key');

    const revoked = await store.revokeConsent('525', 'owner', '2026-07-18T00:02:00.000Z');
    expect(revoked).toMatchObject({ enabled: false, actor: 'owner', revoked_at: '2026-07-18T00:02:00.000Z' });
    expect(client.calls.some((call) => call.sql.includes('UPDATE store_publishing_consents'))).toBe(true);
  });

  it('rolls back intent and outbox creation as one transaction', async () => {
    const client = new FakeClient((sql) => {
      if (sql.includes('INSERT INTO publish_outbox')) throw new Error('connection dropped');
      return { rows: [] };
    });
    const store = new PostgresJobStore(client);
    await expect(store.prepareIntents([intentRecords()])).rejects.toThrow('connection dropped');
    expect(client.calls.map((call) => call.sql.trim())).toEqual(expect.arrayContaining(['BEGIN', 'ROLLBACK']));
    expect(client.calls.some((call) => call.sql.trim() === 'COMMIT')).toBe(false);
  });

  it('supports intent lookup, uncertain reconciliation and atomic completion', async () => {
    const intent = intentRecords().intent;
    const client = new FakeClient((sql) => {
      if (sql.startsWith('SELECT 1 AS schema_version')) return { rows: [intent] };
      if (sql.includes('status=ANY')) return { rows: [intent] };
      if (sql.startsWith('SELECT COUNT')) return { rows: [{ count: '3' }] };
      return { rows: [] };
    });
    const store = new PostgresJobStore(client);
    expect(await store.getIntent('525', 'offer-1', 'hash-1')).toEqual(intent);
    expect(await store.listUncertainIntents('525', ['offer-1'])).toEqual([intent]);
    expect(await store.countSucceededSince('525', '2026-07-18T00:00:00.000Z')).toBe(3);
    await store.recordNegativeReconciliation(intent.intent_id, false);
    expect(client.calls.at(-1)?.values?.[0]).toBe('unknown');
    await store.markReconciled(intent.intent_id, 'succeeded', 42);
    expect(client.calls.slice(-4).map((call) => call.sql.trim())).toEqual(expect.arrayContaining(['BEGIN', 'COMMIT']));
    expect(client.calls.some((call) => call.sql.includes("status='reconciled'"))).toBe(true);
  });

  it('mirrors manifests and attempts transactionally and rolls back a failed mirror', async () => {
    const manifest = manifestFixture();
    const success = new FakeClient();
    await new PostgresJobStore(success).mirrorManifest(manifest, 'batch-1', 'offer-1');
    expect(success.calls.map((call) => call.sql.trim())).toEqual(expect.arrayContaining(['BEGIN', 'COMMIT']));
    expect(success.calls.some((call) => call.sql.includes('INSERT INTO workflow_runs'))).toBe(true);
    expect(success.calls.some((call) => call.sql.includes('INSERT INTO workflow_step_attempts'))).toBe(true);

    const failed = new FakeClient((sql) => {
      if (sql.includes('workflow_step_attempts')) throw new Error('mirror failed');
      return { rows: [] };
    });
    await expect(new PostgresJobStore(failed).mirrorManifest(manifest)).rejects.toThrow('mirror failed');
    expect(failed.calls.at(-1)?.sql.trim()).toBe('ROLLBACK');
  });

  it('propagates connection failures instead of pretending durable state succeeded', async () => {
    const client = new FakeClient(() => { throw new Error('postgres unavailable'); });
    await expect(new PostgresJobStore(client).migrate()).rejects.toThrow('postgres unavailable');
  });
});

describe('PostgreSQL Review State Reader', () => {
  it('decodes batch/run JSON and reads attempts with parameterized run IDs', async () => {
    const manifest = manifestFixture();
    const batch = batchFixture();
    const client = new FakeClient((sql, values) => {
      if (sql.includes('FROM listing_jobs')) return { rows: [{ result_json: JSON.stringify(batch) }] };
      if (sql.includes('FROM workflow_runs WHERE')) return { rows: [{ manifest_json: JSON.stringify(manifest) }] };
      if (sql.includes('FROM workflow_runs ORDER')) return { rows: [{ manifest_json: manifest }] };
      if (sql.includes('FROM workflow_step_attempts')) return { rows: [{ step_name: 'source-1688', attempt: 1, status: 'succeeded' }] };
      return { rows: [] };
    });
    const reader = new PostgresReviewConsoleStateReader(client);
    const overview = await reader.readOverview();
    expect(overview.batches).toEqual([batch]);
    expect(overview.runs).toEqual([expect.objectContaining({ run_id: 'run-1', status: 'succeeded' })]);
    const run = await reader.readRun('run-1') as { manifest: WorkflowRunManifestV2; step_attempts: unknown[] };
    expect(run.manifest.run_id).toBe('run-1');
    expect(run.step_attempts).toHaveLength(1);
    expect(client.calls.filter((call) => call.values?.[0] === 'run-1')).toHaveLength(2);
  });
});

class FakeClient implements PostgresQueryClientV1 {
  readonly calls: Array<{ sql: string; values?: unknown[] }> = [];
  constructor(private readonly responder: (sql: string, values?: unknown[]) => { rows: unknown[] } = () => ({ rows: [] })) {}
  async query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> {
    this.calls.push({ sql, ...(values ? { values } : {}) });
    return this.responder(sql, values) as { rows: T[] };
  }
}

function consentRecord(): StorePublishingConsentV1 {
  return {
    schema_version: 1, consent_id: 'consent-1', store_id: '525', enabled: true,
    actor: 'owner', source: 'setup_cli', created_at: '2026-07-18T00:00:00.000Z', revoked_at: null,
    profile_hash: 'a'.repeat(64), policy_version: 'automatic-publish-v1',
  };
}

function intentRecords(): { intent: PublishIntentV1; outbox: OutboxRecordV1 } {
  const intent: PublishIntentV1 = {
    schema_version: 1, intent_id: 'intent-1', run_id: 'run-1', store_id: '525', offer_id: 'offer-1', item_hash: 'hash-1',
    status: 'prepared', task_id: null, product_id: null, reconciliation_checks: 0, last_reconciliation_at: null,
    created_at: '2026-07-18T00:00:00.000Z', updated_at: '2026-07-18T00:00:00.000Z',
  };
  return {
    intent,
    outbox: {
      schema_version: 1, outbox_id: 'outbox-1', intent_id: intent.intent_id, status: 'pending', attempts: 0,
      last_error_code: null, created_at: intent.created_at, updated_at: intent.updated_at,
    },
  };
}

function manifestFixture(): WorkflowRunManifestV2 {
  const pending = () => ({
    status: 'pending' as const, current_attempt: 0, output: null, input_hash: null, dependency_hashes: {},
    implementation_version: '1', artifact: null, artifacts: [], started_at: null, completed_at: null,
    error: null, error_code: null, attempts: [],
  });
  const steps = Object.fromEntries(WORKFLOW_STEP_NAMES.map((name) => [name, pending()])) as WorkflowRunManifestV2['steps'];
  steps['source-1688'] = {
    ...pending(), status: 'succeeded', current_attempt: 1, started_at: '2026-07-18T00:00:00.000Z', completed_at: '2026-07-18T00:00:01.000Z',
    attempts: [{
      attempt: 1, status: 'succeeded', input_hash: 'input', dependency_hashes: {}, implementation_version: '1',
      artifact: null, artifacts: [], started_at: '2026-07-18T00:00:00.000Z', completed_at: '2026-07-18T00:00:01.000Z', error: null,
    }],
  };
  return {
    schema_version: 2, run_id: 'run-1', workflow: 'listing-preparation', workflow_version: '2.0.0',
    current_step: 'source-1688', status: 'succeeded', created_at: '2026-07-18T00:00:00.000Z',
    updated_at: '2026-07-18T00:00:01.000Z', steps,
  };
}

function batchFixture(): ListingBatchResultV1 {
  return {
    schema_version: 1, batch_id: 'batch-1', store_id: '525', status: 'completed', requested_listing_count: 1,
    candidate_count: 1, succeeded_count: 1, failed_count: 0, skipped_count: 0,
    product_runs: [], created_at: '2026-07-18T00:00:00.000Z', updated_at: '2026-07-18T00:00:01.000Z', warnings: [], errors: [],
  };
}
