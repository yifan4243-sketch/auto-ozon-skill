import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { ListingBatchResultV1, ListingJobSpecV1, OutboxRecordV1, PublishAuthorizationV1, PublishIntentV1, StorePublishingConsentV1, WorkflowRunManifestV2 } from '@auto-ozon/contracts';
import type { PublishReliabilityStore } from './types.js';

export class SqliteJobStore implements PublishReliabilityStore {
  private readonly database: Database.Database;

  constructor(file = path.resolve('data/state/auto-ozon.sqlite')) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Windows can briefly retain an SQLite file lock while another workflow
    // connection is committing or closing. Keep lock waiting bounded so WAL
    // initialization is reliable without hiding a persistent storage failure.
    this.database = new Database(file, { timeout: 5_000 });
    this.database.pragma('busy_timeout = 5000');
    this.database.pragma('journal_mode = WAL');
    this.database.pragma('foreign_keys = ON');
    this.migrate();
  }

  createConsent(record: StorePublishingConsentV1): void {
    this.database.prepare(`INSERT OR IGNORE INTO store_publishing_consents
      (consent_id, store_id, enabled, actor, source, profile_hash, policy_version, payload_json, created_at, revoked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      record.consent_id, record.store_id, record.enabled ? 1 : 0, record.actor, record.source,
      record.profile_hash, record.policy_version, JSON.stringify(record), record.created_at, record.revoked_at,
    );
  }

  getActiveConsent(storeId: string): StorePublishingConsentV1 | null {
    const row = this.database.prepare(`SELECT payload_json FROM store_publishing_consents
      WHERE store_id=? AND enabled=1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`)
      .get(storeId) as { payload_json: string } | undefined;
    return row ? JSON.parse(row.payload_json) as StorePublishingConsentV1 : null;
  }

  revokeConsent(storeId: string, actor: string, revokedAt: string): StorePublishingConsentV1 | null {
    const active = this.getActiveConsent(storeId);
    if (!active) return null;
    const revoked: StorePublishingConsentV1 = { ...active, enabled: false, actor, revoked_at: revokedAt };
    this.database.prepare(`UPDATE store_publishing_consents SET enabled=0, actor=?, revoked_at=?, payload_json=?
      WHERE consent_id=? AND revoked_at IS NULL`).run(actor, revokedAt, JSON.stringify(revoked), active.consent_id);
    return revoked;
  }

  createAuthorization(record: PublishAuthorizationV1): void {
    this.database.prepare(`INSERT OR IGNORE INTO authorization_records
      (authorization_id, consent_id, run_id, store_id, profile_hash, draft_sha256, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(record.authorization_id, record.consent_id, record.run_id, record.store_id,
      record.profile_hash, record.draft_sha256, JSON.stringify(record), record.created_at);
  }

  upsertJob(spec: ListingJobSpecV1, result?: ListingBatchResultV1): void {
    const now = result?.updated_at ?? spec.created_at;
    this.database.prepare(`INSERT INTO listing_jobs
      (job_id,store_id,status,spec_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(job_id) DO UPDATE SET store_id=excluded.store_id,status=excluded.status,spec_json=excluded.spec_json,updated_at=excluded.updated_at`)
      .run(spec.batch_id, spec.store_id, result?.status ?? 'created', JSON.stringify(spec), spec.created_at, now);
    if (result) this.upsertBatchResult(result);
  }

  upsertBatchResult(result: ListingBatchResultV1): void {
    this.database.transaction(() => {
      this.database.prepare('UPDATE listing_jobs SET status=?,result_json=?,updated_at=? WHERE job_id=?')
        .run(result.status, JSON.stringify(result), result.updated_at, result.batch_id);
      const statement = this.database.prepare(`INSERT INTO product_runs
        (job_id,offer_id,run_id,keyword,status,profile,attempts,listing_count,error_code,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(job_id,offer_id) DO UPDATE SET run_id=excluded.run_id,keyword=excluded.keyword,status=excluded.status,
          profile=excluded.profile,attempts=excluded.attempts,listing_count=excluded.listing_count,error_code=excluded.error_code,updated_at=excluded.updated_at`);
      for (const product of result.product_runs) {
        statement.run(result.batch_id, product.offer_id, product.run_id, product.keyword, product.status,
          product.profile, product.attempts, product.listing_count ?? 0, product.error_code, result.updated_at);
      }
    })();
  }

  mirrorManifest(manifest: WorkflowRunManifestV2, batchId: string | null = null, offerId: string | null = null): void {
    this.database.transaction(() => {
      this.database.prepare(`INSERT INTO workflow_runs
        (run_id,job_id,offer_id,status,current_step,manifest_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(run_id) DO UPDATE SET job_id=COALESCE(excluded.job_id,workflow_runs.job_id),
          offer_id=COALESCE(excluded.offer_id,workflow_runs.offer_id),status=excluded.status,current_step=excluded.current_step,
          manifest_json=excluded.manifest_json,updated_at=excluded.updated_at`)
        .run(manifest.run_id, batchId, offerId, manifest.status, manifest.current_step, JSON.stringify(manifest), manifest.created_at, manifest.updated_at);
      const statement = this.database.prepare(`INSERT INTO workflow_step_attempts
        (run_id,step_name,attempt,status,input_hash,dependency_hashes_json,implementation_version,artifact_json,started_at,completed_at,error_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(run_id,step_name,attempt) DO UPDATE SET status=excluded.status,input_hash=excluded.input_hash,
          dependency_hashes_json=excluded.dependency_hashes_json,implementation_version=excluded.implementation_version,
          artifact_json=excluded.artifact_json,started_at=excluded.started_at,completed_at=excluded.completed_at,error_json=excluded.error_json`);
      for (const [stepName, step] of Object.entries(manifest.steps)) {
        for (const attempt of step.attempts) {
          statement.run(manifest.run_id, stepName, attempt.attempt, attempt.status, attempt.input_hash,
            JSON.stringify(attempt.dependency_hashes), attempt.implementation_version,
            attempt.artifacts.length ? JSON.stringify(attempt.artifacts) : null, attempt.started_at, attempt.completed_at,
            attempt.error ? JSON.stringify(attempt.error) : null);
        }
      }
    })();
  }

  prepareIntents(records: Array<{ intent: PublishIntentV1; outbox: OutboxRecordV1 }>): void {
    this.database.transaction((rows: typeof records) => {
      const intentStatement = this.database.prepare(`INSERT OR IGNORE INTO publish_intents
        (intent_id, run_id, store_id, offer_id, item_hash, status, task_id, product_id, reconciliation_checks, last_reconciliation_at, payload_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const outboxStatement = this.database.prepare(`INSERT OR IGNORE INTO publish_outbox
        (outbox_id, intent_id, status, attempts, last_error_code, payload_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const { intent, outbox } of rows) {
        intentStatement.run(intent.intent_id, intent.run_id, intent.store_id, intent.offer_id, intent.item_hash,
          intent.status, intent.task_id, intent.product_id, intent.reconciliation_checks, intent.last_reconciliation_at,
          JSON.stringify(intent), intent.created_at, intent.updated_at);
        outboxStatement.run(outbox.outbox_id, outbox.intent_id, outbox.status, outbox.attempts,
          outbox.last_error_code, JSON.stringify(outbox), outbox.created_at, outbox.updated_at);
      }
    })(records);
  }

  getIntent(storeId: string, offerId: string, itemHash: string): PublishIntentV1 | null {
    const row = this.database.prepare('SELECT * FROM publish_intents WHERE store_id=? AND offer_id=? AND item_hash=?')
      .get(storeId, offerId, itemHash) as IntentRow | undefined;
    return row ? toIntent(row) : null;
  }

  listUncertainIntents(storeId: string, offerIds: string[]): PublishIntentV1[] {
    if (!offerIds.length) return [];
    const placeholders = offerIds.map(() => '?').join(',');
    const rows = this.database.prepare(`SELECT * FROM publish_intents WHERE store_id=? AND offer_id IN (${placeholders}) AND status IN ('prepared','submitted','polling','unknown')`)
      .all(storeId, ...offerIds) as IntentRow[];
    return rows.map(toIntent);
  }

  countSucceededSince(storeId: string, since: string): number {
    const row = this.database.prepare("SELECT COUNT(*) AS count FROM publish_intents WHERE store_id=? AND status='succeeded' AND updated_at>=?").get(storeId, since) as { count: number };
    return Number(row.count);
  }

  markSubmitted(intentIds: string[], taskId: string): void {
    const now = new Date().toISOString();
    this.database.transaction((ids: string[]) => {
      for (const id of ids) {
        this.database.prepare("UPDATE publish_intents SET status='submitted', task_id=?, updated_at=? WHERE intent_id=?").run(taskId, now, id);
        this.database.prepare("UPDATE publish_outbox SET status='submitted', attempts=attempts+1, updated_at=? WHERE intent_id=?").run(now, id);
      }
    })(intentIds);
  }

  recordNegativeReconciliation(intentId: string, safeToRetry: boolean): void {
    const now = new Date().toISOString();
    this.database.prepare(`UPDATE publish_intents SET status=?, reconciliation_checks=reconciliation_checks+1,
      last_reconciliation_at=?, updated_at=? WHERE intent_id=?`)
      .run(safeToRetry ? 'failed' : 'unknown', now, now, intentId);
  }

  markReconciled(intentId: string, status: 'succeeded' | 'failed', productId: number | null): void {
    const now = new Date().toISOString();
    this.database.transaction(() => {
      this.database.prepare('UPDATE publish_intents SET status=?, product_id=?, updated_at=? WHERE intent_id=?').run(status, productId, now, intentId);
      this.database.prepare("UPDATE publish_outbox SET status='reconciled', updated_at=? WHERE intent_id=?").run(now, intentId);
    })();
  }

  close(): void { this.database.close(); }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS authorization_records (
        authorization_id TEXT PRIMARY KEY, consent_id TEXT, run_id TEXT NOT NULL, store_id TEXT NOT NULL,
        profile_hash TEXT NOT NULL, draft_sha256 TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS store_publishing_consents (
        consent_id TEXT PRIMARY KEY, store_id TEXT NOT NULL, enabled INTEGER NOT NULL, actor TEXT NOT NULL,
        source TEXT NOT NULL, profile_hash TEXT NOT NULL, policy_version TEXT NOT NULL,
        payload_json TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS active_store_publishing_consent
        ON store_publishing_consents(store_id) WHERE revoked_at IS NULL AND enabled=1;
      CREATE TABLE IF NOT EXISTS listing_jobs (
        job_id TEXT PRIMARY KEY, store_id TEXT NOT NULL, status TEXT NOT NULL, spec_json TEXT NOT NULL,
        result_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS product_runs (
        job_id TEXT NOT NULL REFERENCES listing_jobs(job_id), offer_id TEXT NOT NULL, run_id TEXT,
        keyword TEXT NOT NULL, status TEXT NOT NULL, profile TEXT, attempts INTEGER NOT NULL,
        listing_count INTEGER NOT NULL DEFAULT 0, error_code TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(job_id,offer_id)
      );
      CREATE INDEX IF NOT EXISTS product_runs_run_id ON product_runs(run_id);
      CREATE TABLE IF NOT EXISTS workflow_runs (
        run_id TEXT PRIMARY KEY, job_id TEXT, offer_id TEXT, status TEXT NOT NULL, current_step TEXT,
        manifest_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workflow_step_attempts (
        run_id TEXT NOT NULL REFERENCES workflow_runs(run_id), step_name TEXT NOT NULL, attempt INTEGER NOT NULL,
        status TEXT NOT NULL, input_hash TEXT, dependency_hashes_json TEXT NOT NULL, implementation_version TEXT NOT NULL,
        artifact_json TEXT, started_at TEXT NOT NULL, completed_at TEXT, error_json TEXT,
        PRIMARY KEY(run_id,step_name,attempt)
      );
      CREATE TABLE IF NOT EXISTS publish_intents (
        intent_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, store_id TEXT NOT NULL, offer_id TEXT NOT NULL,
        item_hash TEXT NOT NULL, status TEXT NOT NULL, task_id TEXT, product_id INTEGER,
        reconciliation_checks INTEGER NOT NULL DEFAULT 0, last_reconciliation_at TEXT,
        payload_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(store_id, offer_id, item_hash)
      );
      CREATE INDEX IF NOT EXISTS publish_intents_uncertain ON publish_intents(store_id, status);
      CREATE TABLE IF NOT EXISTS publish_outbox (
        outbox_id TEXT PRIMARY KEY, intent_id TEXT NOT NULL UNIQUE REFERENCES publish_intents(intent_id),
        status TEXT NOT NULL, attempts INTEGER NOT NULL, last_error_code TEXT,
        payload_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
    const productColumns = this.database.prepare('PRAGMA table_info(product_runs)').all() as Array<{ name: string }>;
    if (!productColumns.some((column) => column.name === 'listing_count')) {
      this.database.exec('ALTER TABLE product_runs ADD COLUMN listing_count INTEGER NOT NULL DEFAULT 0');
    }
    const intentColumns = this.database.prepare('PRAGMA table_info(publish_intents)').all() as Array<{ name: string }>;
    if (!intentColumns.some((column) => column.name === 'reconciliation_checks')) {
      this.database.exec('ALTER TABLE publish_intents ADD COLUMN reconciliation_checks INTEGER NOT NULL DEFAULT 0');
    }
    if (!intentColumns.some((column) => column.name === 'last_reconciliation_at')) {
      this.database.exec('ALTER TABLE publish_intents ADD COLUMN last_reconciliation_at TEXT');
    }
    const authorizationColumns = this.database.prepare('PRAGMA table_info(authorization_records)').all() as Array<{ name: string }>;
    if (!authorizationColumns.some((column) => column.name === 'consent_id')) {
      this.database.exec('ALTER TABLE authorization_records ADD COLUMN consent_id TEXT');
    }
  }
}

interface IntentRow { intent_id: string; run_id: string; store_id: string; offer_id: string; item_hash: string; status: PublishIntentV1['status']; task_id: string | null; product_id: number | null; reconciliation_checks: number; last_reconciliation_at: string | null; created_at: string; updated_at: string }
function toIntent(row: IntentRow): PublishIntentV1 {
  return { schema_version: 1, intent_id: row.intent_id, run_id: row.run_id, store_id: row.store_id,
    offer_id: row.offer_id, item_hash: row.item_hash, status: row.status, task_id: row.task_id,
    product_id: row.product_id, reconciliation_checks: row.reconciliation_checks ?? 0,
    last_reconciliation_at: row.last_reconciliation_at ?? null, created_at: row.created_at, updated_at: row.updated_at };
}
