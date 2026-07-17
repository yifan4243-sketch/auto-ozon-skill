import type { AuthorizationRecordV1, OutboxRecordV1, PublishIntentV1 } from '@auto-ozon/contracts';

export interface PublishReliabilityStore {
  createAuthorization(record: AuthorizationRecordV1): void | Promise<void>;
  prepareIntents(records: Array<{ intent: PublishIntentV1; outbox: OutboxRecordV1 }>): void | Promise<void>;
  getIntent(storeId: string, offerId: string, itemHash: string): PublishIntentV1 | null | Promise<PublishIntentV1 | null>;
  listUncertainIntents(storeId: string, offerIds: string[]): PublishIntentV1[] | Promise<PublishIntentV1[]>;
  markSubmitted(intentIds: string[], taskId: string): void | Promise<void>;
  markReconciled(intentId: string, status: 'succeeded' | 'failed', productId: number | null): void | Promise<void>;
  close(): void | Promise<void>;
}
