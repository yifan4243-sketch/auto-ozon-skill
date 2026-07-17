import type { BatchProductRunV1, ListingBatchResultV1, ListingJobSpecV1 } from '@auto-ozon/contracts';
import { collectWithAccountFailover } from '@auto-ozon/market-selection';
import { FileBatchStore } from './store.js';

export interface BatchCandidateV1 { offer_id: string; keyword: string }
export interface BatchCandidateProviderV1 {
  candidates(keyword: string, limit: number, signal?: AbortSignal): Promise<BatchCandidateV1[]>;
}
export interface BatchProductExecutorV1 {
  execute(candidate: BatchCandidateV1, options: {
    profile: string; attempt: number; run_id: string; spec: ListingJobSpecV1; signal?: AbortSignal;
  }): Promise<{ run_id: string; listing_count: number }>;
}

export async function createListingBatch(spec: ListingJobSpecV1, store = new FileBatchStore()): Promise<ListingBatchResultV1> {
  validateSpec(spec);
  return store.create(spec);
}

export async function runListingBatch(input: {
  batch_id: string; candidate_provider: BatchCandidateProviderV1; product_executor: BatchProductExecutorV1;
  store?: FileBatchStore; signal?: AbortSignal;
}): Promise<ListingBatchResultV1> {
  const store = input.store ?? new FileBatchStore();
  const spec = await store.readSpec(input.batch_id);
  let result = await store.readResult(input.batch_id);
  const completedOffers = new Set(result.product_runs.map((item) => item.offer_id));
  result = await save(store, { ...result, status: 'running' });
  const perKeywordLimit = Math.max(1, Math.ceil(spec.collection.candidate_limit / spec.keywords.length));
  for (const keyword of spec.keywords) {
    const candidates = await input.candidate_provider.candidates(keyword, perKeywordLimit, input.signal);
    for (const candidate of candidates) {
      if (result.succeeded_count >= spec.requested_listing_count) return save(store, { ...result, status: 'completed' });
      if (result.candidate_count >= spec.collection.candidate_limit) return save(store, { ...result, status: 'exhausted' });
      if (completedOffers.has(candidate.offer_id)) continue;
      if (input.signal?.aborted) throw new Error('BATCH_ABORTED');
      completedOffers.add(candidate.offer_id);
      const runId = `${spec.batch_id}-${sanitizeOfferId(candidate.offer_id)}`;
      const failover = await collectWithAccountFailover(spec.collection.profiles, async (profile, attempt) =>
        input.product_executor.execute(candidate, { profile, attempt, run_id: runId, spec, signal: input.signal }), 3,
        { stop_on_error_codes: spec.collection.captcha_policy === 'pause' ? ['RISK_CONTROL'] : [] });
      const lastAttempt = failover.attempts.at(-1);
      const product: BatchProductRunV1 = failover.status === 'succeeded'
        ? { offer_id: candidate.offer_id, keyword, run_id: failover.value!.run_id, status: 'succeeded', profile: lastAttempt?.profile ?? null, attempts: failover.attempts.length, error_code: null }
        : { offer_id: candidate.offer_id, keyword, run_id: null, status: failover.status === 'stopped' ? 'paused' : 'skipped', profile: lastAttempt?.profile ?? null, attempts: failover.attempts.length, error_code: failover.final_error_code };
      result = await save(store, recount({ ...result, candidate_count: result.candidate_count + 1, product_runs: [...result.product_runs, product] }, failover.value?.listing_count ?? 0));
      if (product.status === 'paused') {
        return save(store, { ...result, status: 'paused' });
      }
    }
  }
  return save(store, { ...result, status: result.succeeded_count >= spec.requested_listing_count ? 'completed' : 'exhausted' });
}

function recount(result: ListingBatchResultV1, addedListings: number): ListingBatchResultV1 {
  const succeededProducts = result.product_runs.filter((item) => item.status === 'succeeded').length;
  const previousSucceededProducts = Math.max(0, succeededProducts - (addedListings > 0 ? 1 : 0));
  const priorListings = result.succeeded_count;
  return {
    ...result,
    succeeded_count: addedListings > 0 && succeededProducts > previousSucceededProducts ? priorListings + addedListings : priorListings,
    failed_count: result.product_runs.filter((item) => item.status === 'failed').length,
    skipped_count: result.product_runs.filter((item) => item.status === 'skipped').length,
  };
}

async function save(store: FileBatchStore, result: ListingBatchResultV1): Promise<ListingBatchResultV1> {
  const updated = { ...result, updated_at: new Date().toISOString() };
  await store.writeResult(updated);
  return updated;
}

function validateSpec(spec: ListingJobSpecV1): void {
  if (spec.schema_version !== 1) throw new Error('LISTING_JOB_SCHEMA_UNSUPPORTED');
  if (!Number.isSafeInteger(spec.requested_listing_count) || spec.requested_listing_count < 1 || spec.requested_listing_count > 100) throw new Error('REQUESTED_LISTING_COUNT_INVALID');
  if (spec.collection.attempts_per_account !== 3 || spec.collection.profiles.length < 2) throw new Error('TWO_ACCOUNTS_THREE_ATTEMPTS_REQUIRED');
  if (!Number.isSafeInteger(spec.collection.candidate_limit) || spec.collection.candidate_limit < spec.requested_listing_count) throw new Error('CANDIDATE_LIMIT_INVALID');
  if (spec.keywords.length === 0 || spec.keywords.some((keyword) => !keyword.trim())) throw new Error('KEYWORDS_REQUIRED');
  if (spec.route === 'keyword' && spec.keywords.length !== 1) throw new Error('KEYWORD_ROUTE_REQUIRES_ONE_KEYWORD');
}

function sanitizeOfferId(value: string): string {
  if (!/^[0-9]{5,32}$/u.test(value)) throw new Error('OFFER_ID_INVALID');
  return value;
}
