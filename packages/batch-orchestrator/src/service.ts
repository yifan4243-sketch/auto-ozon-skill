import type { BatchProductRunV1, ListingBatchResultV1, ListingJobSpecV1 } from '@auto-ozon/contracts';
import { collectWithAccountFailover } from '@auto-ozon/market-selection';
import { FileBatchStore } from './store.js';

export interface BatchCandidateV1 { offer_id: string; keyword: string }
export interface BatchCandidateProviderV1 {
  candidates(keyword: string, limit: number, signal?: AbortSignal): Promise<BatchCandidateV1[]>;
}
export interface BatchProductExecutorV1 {
  execute(candidate: BatchCandidateV1, options: {
    profile: string; attempt: number; run_id: string; spec: ListingJobSpecV1;
    remaining_listing_capacity: number; signal?: AbortSignal;
  }): Promise<{ run_id: string; listing_count: number; status?: 'succeeded' | 'paused' | 'partial_failed' }>;
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
  const completedOffers = new Set(result.product_runs.filter((item) => item.status !== 'paused').map((item) => item.offer_id));
  result = await save(store, { ...result, status: 'running' });
  const perKeywordLimit = Math.max(1, Math.ceil(spec.collection.candidate_limit / spec.keywords.length));
  for (const keyword of spec.keywords) {
    const keywordTarget = spec.keyword_listing_targets[keyword] ?? 0;
    if (keywordTarget <= 0) continue;
    const paused = result.product_runs.filter((item) => item.status === 'paused' && item.keyword === keyword).map((item) => ({ offer_id: item.offer_id, keyword: item.keyword }));
    let discovered: BatchCandidateV1[];
    try { discovered = await input.candidate_provider.candidates(keyword, perKeywordLimit, input.signal); }
    catch (error) {
      const code = normalizeCode(error);
      if (code === 'RISK_CONTROL' && spec.collection.captcha_policy === 'pause') return save(store, { ...result, status: 'paused' });
      throw error;
    }
    const candidates = [...paused, ...discovered.filter((item) => !paused.some((prior) => prior.offer_id === item.offer_id))];
    for (const candidate of candidates) {
      if (result.succeeded_count >= spec.requested_listing_count) return save(store, { ...result, status: 'completed' });
      const keywordSucceeded = result.product_runs
        .filter((item) => item.keyword === keyword)
        .reduce((sum, item) => sum + item.listing_count, 0);
      if (keywordSucceeded >= keywordTarget) break;
      const existingIndex = result.product_runs.findIndex((item) => item.offer_id === candidate.offer_id);
      if (existingIndex < 0 && result.candidate_count >= spec.collection.candidate_limit) return save(store, { ...result, status: result.product_runs.some((item) => item.status === 'paused') ? 'paused' : 'exhausted' });
      if (completedOffers.has(candidate.offer_id)) continue;
      if (input.signal?.aborted) throw new Error('BATCH_ABORTED');
      completedOffers.add(candidate.offer_id);
      const runId = `${spec.batch_id}-${sanitizeOfferId(candidate.offer_id)}`;
      const remainingListingCapacity = Math.min(
        spec.requested_listing_count - result.succeeded_count,
        keywordTarget - keywordSucceeded,
      );
      const failover = await collectWithAccountFailover(spec.collection.profiles, async (profile, attempt) =>
        input.product_executor.execute(candidate, {
          profile, attempt, run_id: runId, spec,
          remaining_listing_capacity: remainingListingCapacity,
          signal: input.signal,
        }), 3,
        { stop_on_error_codes: spec.collection.captcha_policy === 'pause' ? ['RISK_CONTROL'] : [] });
      const lastAttempt = failover.attempts.at(-1);
      const product: BatchProductRunV1 = failover.status === 'succeeded'
        ? { offer_id: candidate.offer_id, keyword, run_id: failover.value!.run_id,
            status: failover.value!.status === 'paused' ? 'paused' : failover.value!.status === 'partial_failed' ? 'partial_failed' : 'succeeded',
            profile: lastAttempt?.profile ?? null, attempts: failover.attempts.length,
            listing_count: failover.value!.listing_count,
            error_code: failover.value!.status === 'partial_failed' ? 'PARTIAL_PUBLISH_FAILED' : null }
        : { offer_id: candidate.offer_id, keyword, run_id: null, status: failover.status === 'stopped' ? 'paused' : failover.status === 'failed' ? 'failed' : 'skipped', profile: lastAttempt?.profile ?? null, attempts: failover.attempts.length, listing_count: 0, error_code: failover.final_error_code };
      const productRuns = existingIndex >= 0 ? result.product_runs.map((item, index) => index === existingIndex ? product : item) : [...result.product_runs, product];
      result = await save(store, recount({ ...result, candidate_count: result.candidate_count + (existingIndex >= 0 ? 0 : 1), product_runs: productRuns }));
      if (product.status === 'paused') {
        return save(store, { ...result, status: 'paused' });
      }
    }
  }
  return save(store, { ...result, status: result.succeeded_count >= spec.requested_listing_count ? 'completed' : result.product_runs.some((item) => item.status === 'paused') ? 'paused' : 'exhausted' });
}

function recount(result: ListingBatchResultV1): ListingBatchResultV1 {
  return {
    ...result,
    succeeded_count: result.product_runs.reduce((sum, item) => sum + (item.listing_count ?? 0), 0),
    failed_count: result.product_runs.filter((item) => item.status === 'failed').length,
    skipped_count: result.product_runs.filter((item) => item.status === 'skipped').length,
    partial_failed_count: result.product_runs.filter((item) => item.status === 'partial_failed').length,
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
  if (!Number.isSafeInteger(spec.collection.max_sku_per_product) || spec.collection.max_sku_per_product < 1) throw new Error('MAX_SKU_INVALID');
  if ((spec.collection.price_min_cny !== null && (!Number.isFinite(spec.collection.price_min_cny) || spec.collection.price_min_cny < 0))
    || (spec.collection.price_max_cny !== null && (!Number.isFinite(spec.collection.price_max_cny) || spec.collection.price_max_cny <= 0))
    || (spec.collection.price_min_cny !== null && spec.collection.price_max_cny !== null && spec.collection.price_min_cny > spec.collection.price_max_cny)) throw new Error('PRICE_RANGE_INVALID');
  if (spec.collection.profiles.some((profile) => !/^[A-Za-z0-9_-]{1,64}$/u.test(profile))) throw new Error('PROFILE_NAME_INVALID');
  if (spec.keywords.length === 0 || spec.keywords.some((keyword) => !keyword.trim())) throw new Error('KEYWORDS_REQUIRED');
  if (!spec.keyword_listing_targets
    || Object.keys(spec.keyword_listing_targets).some((keyword) => !spec.keywords.includes(keyword))
    || spec.keywords.some((keyword) => !Number.isSafeInteger(spec.keyword_listing_targets[keyword]) || spec.keyword_listing_targets[keyword]! < 0)
    || Object.values(spec.keyword_listing_targets).reduce((sum, value) => sum + value, 0) !== spec.requested_listing_count) {
    throw new Error('KEYWORD_LISTING_TARGETS_INVALID');
  }
  if (spec.route === 'keyword' && spec.keywords.length !== 1) throw new Error('KEYWORD_ROUTE_REQUIRES_ONE_KEYWORD');
  if (!spec.images || typeof spec.images.generate !== 'boolean') throw new Error('IMAGE_JOB_CONFIG_INVALID');
}

function sanitizeOfferId(value: string): string {
  if (!/^[0-9]{5,32}$/u.test(value)) throw new Error('OFFER_ID_INVALID');
  return value;
}
function normalizeCode(error: unknown): string { return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : error instanceof Error ? error.message : 'BATCH_FAILED'; }
