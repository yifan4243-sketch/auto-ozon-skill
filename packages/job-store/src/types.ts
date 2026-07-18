import type {
  PublishAuthorizationV1,
  ListingBatchResultV1,
  ListingJobSpecV1,
  OutboxRecordV1,
  PublishIntentV1,
  StorePublishingConsentV1,
  WorkflowRunManifestV2,
} from '@auto-ozon/contracts';

export interface WorkflowJobStateStore {
  upsertJob(spec: ListingJobSpecV1, result?: ListingBatchResultV1): void | Promise<void>;
  upsertBatchResult(result: ListingBatchResultV1): void | Promise<void>;
  mirrorManifest(manifest: WorkflowRunManifestV2, batchId?: string | null, offerId?: string | null): void | Promise<void>;
  close(): void | Promise<void>;
}

export interface PublishReliabilityStore extends Partial<WorkflowJobStateStore> {
  createConsent(record: StorePublishingConsentV1): void | Promise<void>;
  getActiveConsent(storeId: string): StorePublishingConsentV1 | null | Promise<StorePublishingConsentV1 | null>;
  revokeConsent(storeId: string, actor: string, revokedAt: string): StorePublishingConsentV1 | null | Promise<StorePublishingConsentV1 | null>;
  createAuthorization(record: PublishAuthorizationV1): void | Promise<void>;
  prepareIntents(records: Array<{ intent: PublishIntentV1; outbox: OutboxRecordV1 }>): void | Promise<void>;
  getIntent(storeId: string, offerId: string, itemHash: string): PublishIntentV1 | null | Promise<PublishIntentV1 | null>;
  listUncertainIntents(storeId: string, offerIds: string[]): PublishIntentV1[] | Promise<PublishIntentV1[]>;
  countSucceededSince(storeId: string, since: string): number | Promise<number>;
  markSubmitted(intentIds: string[], taskId: string): void | Promise<void>;
  recordNegativeReconciliation(intentId: string, safeToRetry: boolean): void | Promise<void>;
  markReconciled(intentId: string, status: 'succeeded' | 'failed', productId: number | null): void | Promise<void>;
  close(): void | Promise<void>;
}
