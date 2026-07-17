import type { AuthorizationRecordV1, OutboxRecordV1, PublishIntentV1 } from '@auto-ozon/contracts';
import type { PublishReliabilityStore } from './types.js';

export interface PostgresQueryClientV1 {
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

/** PostgreSQL adapter with the same reliability contract. The caller owns pooling and credentials. */
export class PostgresJobStore implements PublishReliabilityStore {
  constructor(private readonly client: PostgresQueryClientV1) {}
  async createAuthorization(record: AuthorizationRecordV1): Promise<void> {
    await this.client.query(`INSERT INTO authorization_records (authorization_id, run_id, store_id, profile_hash, draft_sha256, payload_json, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (authorization_id) DO NOTHING`,
      [record.authorization_id, record.run_id, record.store_id, record.profile_hash, record.draft_sha256, JSON.stringify(record), record.authorized_at]);
  }
  async prepareIntents(records: Array<{ intent: PublishIntentV1; outbox: OutboxRecordV1 }>): Promise<void> {
    await this.client.query('BEGIN');
    try {
      for (const { intent, outbox } of records) {
        await this.client.query(`INSERT INTO publish_intents (intent_id,run_id,store_id,offer_id,item_hash,status,task_id,product_id,payload_json,created_at,updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (store_id,offer_id,item_hash) DO NOTHING`,
          [intent.intent_id,intent.run_id,intent.store_id,intent.offer_id,intent.item_hash,intent.status,intent.task_id,intent.product_id,JSON.stringify(intent),intent.created_at,intent.updated_at]);
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
  async markSubmitted(intentIds: string[], taskId: string): Promise<void> {
    await this.client.query("UPDATE publish_intents SET status='submitted',task_id=$1,updated_at=$2 WHERE intent_id=ANY($3)", [taskId,new Date().toISOString(),intentIds]);
  }
  async markReconciled(intentId: string, status: 'succeeded' | 'failed', productId: number | null): Promise<void> {
    await this.client.query('UPDATE publish_intents SET status=$1,product_id=$2,updated_at=$3 WHERE intent_id=$4', [status,productId,new Date().toISOString(),intentId]);
  }
  async close(): Promise<void> {}
}
