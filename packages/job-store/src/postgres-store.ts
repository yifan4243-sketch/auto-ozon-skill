import type { ListingBatchResultV1, ListingJobSpecV1, OutboxRecordV1, PublishAuthorizationV1, PublishIntentV1, StorePublishingConsentV1, WorkflowRunManifestV2 } from '@auto-ozon/contracts';
import type { PublishReliabilityStore } from './types.js';

export interface PostgresQueryClientV1 {
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

export const POSTGRES_JOB_STORE_SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS authorization_records (
  authorization_id TEXT PRIMARY KEY, consent_id TEXT, run_id TEXT NOT NULL, store_id TEXT NOT NULL,
  profile_hash TEXT NOT NULL, draft_sha256 TEXT NOT NULL, payload_json JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL
);
ALTER TABLE authorization_records ADD COLUMN IF NOT EXISTS consent_id TEXT;
CREATE TABLE IF NOT EXISTS store_publishing_consents (
  consent_id TEXT PRIMARY KEY, store_id TEXT NOT NULL, enabled BOOLEAN NOT NULL, actor TEXT NOT NULL,
  source TEXT NOT NULL, profile_hash TEXT NOT NULL, policy_version TEXT NOT NULL,
  payload_json JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL, revoked_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS active_store_publishing_consent
  ON store_publishing_consents(store_id) WHERE revoked_at IS NULL AND enabled=TRUE;
CREATE TABLE IF NOT EXISTS listing_jobs (
  job_id TEXT PRIMARY KEY, store_id TEXT NOT NULL, status TEXT NOT NULL, spec_json JSONB NOT NULL,
  result_json JSONB, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS product_runs (
  job_id TEXT NOT NULL REFERENCES listing_jobs(job_id), offer_id TEXT NOT NULL, run_id TEXT,
  keyword TEXT NOT NULL, status TEXT NOT NULL, profile TEXT, attempts INTEGER NOT NULL,
  listing_count INTEGER NOT NULL DEFAULT 0, error_code TEXT, updated_at TIMESTAMPTZ NOT NULL, PRIMARY KEY(job_id,offer_id)
);
ALTER TABLE product_runs ADD COLUMN IF NOT EXISTS listing_count INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS product_runs_run_id ON product_runs(run_id);
CREATE TABLE IF NOT EXISTS workflow_runs (
  run_id TEXT PRIMARY KEY, job_id TEXT, offer_id TEXT, status TEXT NOT NULL, current_step TEXT,
  manifest_json JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS workflow_step_attempts (
  run_id TEXT NOT NULL REFERENCES workflow_runs(run_id), step_name TEXT NOT NULL, attempt INTEGER NOT NULL,
  status TEXT NOT NULL, input_hash TEXT, dependency_hashes_json JSONB NOT NULL, implementation_version TEXT NOT NULL,
  artifact_json JSONB, started_at TIMESTAMPTZ NOT NULL, completed_at TIMESTAMPTZ, error_json JSONB,
  PRIMARY KEY(run_id,step_name,attempt)
);
CREATE TABLE IF NOT EXISTS publish_intents (
  intent_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, store_id TEXT NOT NULL, offer_id TEXT NOT NULL,
  item_hash TEXT NOT NULL, status TEXT NOT NULL, task_id TEXT, product_id BIGINT,
  reconciliation_checks INTEGER NOT NULL DEFAULT 0, last_reconciliation_at TIMESTAMPTZ,
  payload_json JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE(store_id, offer_id, item_hash)
);
ALTER TABLE publish_intents ADD COLUMN IF NOT EXISTS reconciliation_checks INTEGER NOT NULL DEFAULT 0;
ALTER TABLE publish_intents ADD COLUMN IF NOT EXISTS last_reconciliation_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS publish_intents_uncertain ON publish_intents(store_id, status);
CREATE TABLE IF NOT EXISTS publish_outbox (
  outbox_id TEXT PRIMARY KEY, intent_id TEXT NOT NULL UNIQUE REFERENCES publish_intents(intent_id),
  status TEXT NOT NULL, attempts INTEGER NOT NULL, last_error_code TEXT,
  payload_json JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);`;

/** PostgreSQL adapter with the same reliability contract. The caller owns pooling and credentials. */
export class PostgresJobStore implements PublishReliabilityStore {
  constructor(private readonly client: PostgresQueryClientV1) {}
  async migrate(): Promise<void> { await this.client.query(POSTGRES_JOB_STORE_SCHEMA_V1); }
  async createConsent(record: StorePublishingConsentV1): Promise<void> {
    await this.client.query(`INSERT INTO store_publishing_consents
      (consent_id,store_id,enabled,actor,source,profile_hash,policy_version,payload_json,created_at,revoked_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (consent_id) DO NOTHING`,
      [record.consent_id,record.store_id,record.enabled,record.actor,record.source,record.profile_hash,
        record.policy_version,JSON.stringify(record),record.created_at,record.revoked_at]);
  }
  async getActiveConsent(storeId: string): Promise<StorePublishingConsentV1 | null> {
    const { rows } = await this.client.query<{ payload_json: StorePublishingConsentV1 | string }>(`SELECT payload_json
      FROM store_publishing_consents WHERE store_id=$1 AND enabled=TRUE AND revoked_at IS NULL
      ORDER BY created_at DESC LIMIT 1`, [storeId]);
    const payload = rows[0]?.payload_json;
    return typeof payload === 'string' ? JSON.parse(payload) as StorePublishingConsentV1 : payload ?? null;
  }
  async revokeConsent(storeId: string, actor: string, revokedAt: string): Promise<StorePublishingConsentV1 | null> {
    const active = await this.getActiveConsent(storeId);
    if (!active) return null;
    const revoked: StorePublishingConsentV1 = { ...active, enabled: false, actor, revoked_at: revokedAt };
    await this.client.query(`UPDATE store_publishing_consents SET enabled=FALSE,actor=$1,revoked_at=$2,payload_json=$3
      WHERE consent_id=$4 AND revoked_at IS NULL`, [actor,revokedAt,JSON.stringify(revoked),active.consent_id]);
    return revoked;
  }
  async createAuthorization(record: PublishAuthorizationV1): Promise<void> {
    await this.client.query(`INSERT INTO authorization_records (authorization_id, consent_id, run_id, store_id, profile_hash, draft_sha256, payload_json, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (authorization_id) DO NOTHING`,
      [record.authorization_id, record.consent_id, record.run_id, record.store_id, record.profile_hash, record.draft_sha256, JSON.stringify(record), record.created_at]);
  }
  async upsertJob(spec: ListingJobSpecV1, result?: ListingBatchResultV1): Promise<void> {
    await this.client.query(`INSERT INTO listing_jobs (job_id,store_id,status,spec_json,result_json,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (job_id) DO UPDATE SET store_id=excluded.store_id,status=excluded.status,spec_json=excluded.spec_json,
        result_json=COALESCE(excluded.result_json,listing_jobs.result_json),updated_at=excluded.updated_at`,
      [spec.batch_id,spec.store_id,result?.status ?? 'created',JSON.stringify(spec),result ? JSON.stringify(result) : null,spec.created_at,result?.updated_at ?? spec.created_at]);
    if (result) await this.upsertBatchResult(result);
  }
  async upsertBatchResult(result: ListingBatchResultV1): Promise<void> {
    await this.client.query('BEGIN');
    try {
      await this.client.query('UPDATE listing_jobs SET status=$1,result_json=$2,updated_at=$3 WHERE job_id=$4',
        [result.status,JSON.stringify(result),result.updated_at,result.batch_id]);
      for (const product of result.product_runs) {
        await this.client.query(`INSERT INTO product_runs (job_id,offer_id,run_id,keyword,status,profile,attempts,listing_count,error_code,updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          ON CONFLICT (job_id,offer_id) DO UPDATE SET run_id=excluded.run_id,keyword=excluded.keyword,status=excluded.status,
            profile=excluded.profile,attempts=excluded.attempts,listing_count=excluded.listing_count,error_code=excluded.error_code,updated_at=excluded.updated_at`,
          [result.batch_id,product.offer_id,product.run_id,product.keyword,product.status,product.profile,product.attempts,product.listing_count ?? 0,product.error_code,result.updated_at]);
      }
      await this.client.query('COMMIT');
    } catch (error) { await this.client.query('ROLLBACK'); throw error; }
  }
  async mirrorManifest(manifest: WorkflowRunManifestV2, batchId: string | null = null, offerId: string | null = null): Promise<void> {
    await this.client.query('BEGIN');
    try {
      await this.client.query(`INSERT INTO workflow_runs (run_id,job_id,offer_id,status,current_step,manifest_json,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (run_id) DO UPDATE SET job_id=COALESCE(excluded.job_id,workflow_runs.job_id),
          offer_id=COALESCE(excluded.offer_id,workflow_runs.offer_id),status=excluded.status,current_step=excluded.current_step,
          manifest_json=excluded.manifest_json,updated_at=excluded.updated_at`,
        [manifest.run_id,batchId,offerId,manifest.status,manifest.current_step,JSON.stringify(manifest),manifest.created_at,manifest.updated_at]);
      for (const [stepName, step] of Object.entries(manifest.steps)) for (const attempt of step.attempts) {
        await this.client.query(`INSERT INTO workflow_step_attempts
          (run_id,step_name,attempt,status,input_hash,dependency_hashes_json,implementation_version,artifact_json,started_at,completed_at,error_json)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
          ON CONFLICT (run_id,step_name,attempt) DO UPDATE SET status=excluded.status,input_hash=excluded.input_hash,
            dependency_hashes_json=excluded.dependency_hashes_json,implementation_version=excluded.implementation_version,
            artifact_json=excluded.artifact_json,started_at=excluded.started_at,completed_at=excluded.completed_at,error_json=excluded.error_json`,
          [manifest.run_id,stepName,attempt.attempt,attempt.status,attempt.input_hash,JSON.stringify(attempt.dependency_hashes),
            attempt.implementation_version,attempt.artifacts.length ? JSON.stringify(attempt.artifacts) : null,attempt.started_at,attempt.completed_at,
            attempt.error ? JSON.stringify(attempt.error) : null]);
      }
      await this.client.query('COMMIT');
    } catch (error) { await this.client.query('ROLLBACK'); throw error; }
  }
  async prepareIntents(records: Array<{ intent: PublishIntentV1; outbox: OutboxRecordV1 }>): Promise<void> {
    await this.client.query('BEGIN');
    try {
      for (const { intent, outbox } of records) {
        await this.client.query(`INSERT INTO publish_intents (intent_id,run_id,store_id,offer_id,item_hash,status,task_id,product_id,reconciliation_checks,last_reconciliation_at,payload_json,created_at,updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (store_id,offer_id,item_hash) DO NOTHING`,
          [intent.intent_id,intent.run_id,intent.store_id,intent.offer_id,intent.item_hash,intent.status,intent.task_id,intent.product_id,intent.reconciliation_checks,intent.last_reconciliation_at,JSON.stringify(intent),intent.created_at,intent.updated_at]);
        await this.client.query(`INSERT INTO publish_outbox (outbox_id,intent_id,status,attempts,last_error_code,payload_json,created_at,updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (intent_id) DO NOTHING`,
          [outbox.outbox_id,outbox.intent_id,outbox.status,outbox.attempts,outbox.last_error_code,JSON.stringify(outbox),outbox.created_at,outbox.updated_at]);
      }
      await this.client.query('COMMIT');
    } catch (error) { await this.client.query('ROLLBACK'); throw error; }
  }
  async getIntent(storeId: string, offerId: string, itemHash: string): Promise<PublishIntentV1 | null> {
    const { rows } = await this.client.query<PublishIntentV1>('SELECT 1 AS schema_version,* FROM publish_intents WHERE store_id=$1 AND offer_id=$2 AND item_hash=$3', [storeId, offerId, itemHash]);
    return rows[0] ?? null;
  }
  async listUncertainIntents(storeId: string, offerIds: string[]): Promise<PublishIntentV1[]> {
    if (!offerIds.length) return [];
    const { rows } = await this.client.query<PublishIntentV1>("SELECT 1 AS schema_version,* FROM publish_intents WHERE store_id=$1 AND offer_id=ANY($2) AND status=ANY($3)", [storeId, offerIds, ['prepared','submitted','polling','unknown']]);
    return rows;
  }
  async countSucceededSince(storeId: string, since: string): Promise<number> {
    const { rows } = await this.client.query<{ count: string }>("SELECT COUNT(*) AS count FROM publish_intents WHERE store_id=$1 AND status='succeeded' AND updated_at>=$2", [storeId, since]);
    return Number(rows[0]?.count ?? 0);
  }
  async markSubmitted(intentIds: string[], taskId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.client.query('BEGIN');
    try {
      await this.client.query("UPDATE publish_intents SET status='submitted',task_id=$1,updated_at=$2 WHERE intent_id=ANY($3)", [taskId,now,intentIds]);
      await this.client.query("UPDATE publish_outbox SET status='submitted',attempts=attempts+1,updated_at=$1 WHERE intent_id=ANY($2)", [now,intentIds]);
      await this.client.query('COMMIT');
    } catch (error) { await this.client.query('ROLLBACK'); throw error; }
  }
  async recordNegativeReconciliation(intentId: string, safeToRetry: boolean): Promise<void> {
    const now = new Date().toISOString();
    await this.client.query(`UPDATE publish_intents SET status=$1,reconciliation_checks=reconciliation_checks+1,
      last_reconciliation_at=$2,updated_at=$2 WHERE intent_id=$3`, [safeToRetry ? 'failed' : 'unknown',now,intentId]);
  }
  async markReconciled(intentId: string, status: 'succeeded' | 'failed', productId: number | null): Promise<void> {
    const now = new Date().toISOString();
    await this.client.query('BEGIN');
    try {
      await this.client.query('UPDATE publish_intents SET status=$1,product_id=$2,updated_at=$3 WHERE intent_id=$4', [status,productId,now,intentId]);
      await this.client.query("UPDATE publish_outbox SET status='reconciled',updated_at=$1 WHERE intent_id=$2", [now,intentId]);
      await this.client.query('COMMIT');
    } catch (error) { await this.client.query('ROLLBACK'); throw error; }
  }
  async close(): Promise<void> {}
}
