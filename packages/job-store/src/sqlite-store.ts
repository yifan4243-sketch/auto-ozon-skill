import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { AuthorizationRecordV1, OutboxRecordV1, PublishIntentV1 } from '@auto-ozon/contracts';
import type { PublishReliabilityStore } from './types.js';

export class SqliteJobStore implements PublishReliabilityStore {
  private readonly database: Database.Database;

  constructor(file = path.resolve('data/state/auto-ozon.sqlite')) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.database = new Database(file);
    this.database.pragma('journal_mode = WAL');
    this.database.pragma('foreign_keys = ON');
    this.migrate();
  }

  createAuthorization(record: AuthorizationRecordV1): void {
    this.database.prepare(`INSERT OR IGNORE INTO authorization_records
      (authorization_id, run_id, store_id, profile_hash, draft_sha256, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(record.authorization_id, record.run_id, record.store_id,
      record.profile_hash, record.draft_sha256, JSON.stringify(record), record.authorized_at);
  }

  prepareIntents(records: Array<{ intent: PublishIntentV1; outbox: OutboxRecordV1 }>): void {
    this.database.transaction((rows: typeof records) => {
      const intentStatement = this.database.prepare(`INSERT OR IGNORE INTO publish_intents
        (intent_id, run_id, store_id, offer_id, item_hash, status, task_id, product_id, payload_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const outboxStatement = this.database.prepare(`INSERT OR IGNORE INTO publish_outbox
        (outbox_id, intent_id, status, attempts, last_error_code, payload_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const { intent, outbox } of rows) {
        intentStatement.run(intent.intent_id, intent.run_id, intent.store_id, intent.offer_id, intent.item_hash,
          intent.status, intent.task_id, intent.product_id, JSON.stringify(intent), intent.created_at, intent.updated_at);
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

  markSubmitted(intentIds: string[], taskId: string): void {
    const now = new Date().toISOString();
    this.database.transaction((ids: string[]) => {
      for (const id of ids) {
        this.database.prepare("UPDATE publish_intents SET status='submitted', task_id=?, updated_at=? WHERE intent_id=?").run(taskId, now, id);
        this.database.prepare("UPDATE publish_outbox SET status='submitted', attempts=attempts+1, updated_at=? WHERE intent_id=?").run(now, id);
      }
    })(intentIds);
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
        authorization_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, store_id TEXT NOT NULL,
        profile_hash TEXT NOT NULL, draft_sha256 TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS publish_intents (
        intent_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, store_id TEXT NOT NULL, offer_id TEXT NOT NULL,
        item_hash TEXT NOT NULL, status TEXT NOT NULL, task_id TEXT, product_id INTEGER,
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
  }
}

interface IntentRow { intent_id: string; run_id: string; store_id: string; offer_id: string; item_hash: string; status: PublishIntentV1['status']; task_id: string | null; product_id: number | null; created_at: string; updated_at: string }
function toIntent(row: IntentRow): PublishIntentV1 {
  return { schema_version: 1, intent_id: row.intent_id, run_id: row.run_id, store_id: row.store_id,
    offer_id: row.offer_id, item_hash: row.item_hash, status: row.status, task_id: row.task_id,
    product_id: row.product_id, created_at: row.created_at, updated_at: row.updated_at };
}
