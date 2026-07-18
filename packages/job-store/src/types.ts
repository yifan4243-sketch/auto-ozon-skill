import type {
  AuthorizationRecordV1,
  ListingBatchResultV1,
  ListingJobSpecV1,
  OutboxRecordV1,
  PublishIntentV1,
  WorkflowRunManifestV2,
} from '@auto-ozon/contracts';

export interface WorkflowJobStateStore {
  upsertJob(spec: ListingJobSpecV1, result?: ListingBatchResultV1): void | Promise<void>;
  upsertBatchResult(result: ListingBatchResultV1): void | Promise<void>;
  mirrorManifest(manifest: WorkflowRunManifestV2, batchId?: string | null, offerId?: string | null): void | Promise<void>;
  close(): void | Promise<void>;
}

export interface PublishReliabilityStore extends Partial<WorkflowJobStateStore> {
  createAuthorization(record: AuthorizationRecordV1): void | Promise<void>;
  prepareIntents(records: Array<{ intent: PublishIntentV1; outbox: OutboxRecordV1 }>): void | Promise<void>;
  getIntent(storeId: string, offerId: string, itemHash: string): PublishIntentV1 | null | Promise<PublishIntentV1 | null>;
  listUncertainIntents(storeId: string, offerIds: string[]): PublishIntentV1[] | Promise<PublishIntentV1[]>;
  countSucceededSince(storeId: string, since: string): number | Promise<number>;
  markSubmitted(intentIds: string[], taskId: string): void | Promise<void>;
  recordNegativeReconciliation(intentId: string, safeToRetry: boolean): void | Promise<void>;
  markReconciled(intentId: string, status: 'succeeded' | 'failed', productId: number | null): void | Promise<void>;
  close(): void | Promise<void>;
}
