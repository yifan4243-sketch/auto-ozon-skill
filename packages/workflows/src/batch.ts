import path from 'node:path';
import type { AttributeMappingAgentInputV1, CategoryDecisionV1, CommandResult, CostPricingAgentInputV1, ImageReviewAgentInputV1, ListingBatchResultV1, ListingJobSpecV1 } from '@auto-ozon/contracts';
import { createListingBatch, FileBatchStore, runListingBatch, validateCategoryClosure, type AgentInputKindV1 } from '@auto-ozon/batch-orchestrator';
import { collectWithAccountFailover, runMarketSelection } from '@auto-ozon/market-selection';
import { searchKeywordCandidateIds } from '@auto-ozon/adapters-1688';
import { AgentDecisionProvider } from '@auto-ozon/step-category-decision';
import { FileStoreRegistry } from '@auto-ozon/config';
import { SqliteJobStore, type PublishReliabilityStore, type WorkflowJobStateStore } from '@auto-ozon/job-store';
import { runListingPreparation } from './listing-preparation.js';
import { runListingPublish } from './listing-submit.js';
import { loadConfiguredImageGeneration } from './image-generation-config.js';
import { hashWorkflowValue } from '@auto-ozon/artifact-store';

export interface CreateBatchWorkflowInputV1 {
  batch_id: string;
  store_id: string;
  requested_listing_count: number;
  keyword?: string;
  profiles: [string, string, ...string[]];
  headed: boolean;
  captcha_policy: 'pause' | 'skip_product';
  max_sku_per_product: number;
  price_min_cny: number | null;
  price_max_cny: number | null;
  candidate_limit: number;
  category_count?: number;
  market_snapshot_path?: string;
  generate_images?: boolean;
  store?: FileBatchStore;
  job_store?: PublishReliabilityStore & WorkflowJobStateStore;
}

export async function createBatchWorkflow(input: CreateBatchWorkflowInputV1): Promise<CommandResult<ListingBatchResultV1>> {
  const jobStore = input.job_store ?? new SqliteJobStore();
  const ownsJobStore = !input.job_store;
  try {
    const store = input.store ?? new FileBatchStore();
    const storeProfile = new FileStoreRegistry().get(input.store_id);
    if (!storeProfile.publishing.enabled) throw new Error('STORE_PUBLISHING_DISABLED');
    await assertActiveBatchConsent(jobStore, storeProfile.store_id, hashWorkflowValue(storeProfile));
    if (input.requested_listing_count > storeProfile.publishing.daily_listing_limit) throw new Error('STORE_DAILY_LIMIT_EXCEEDED');
    const createdAt = new Date().toISOString();
    let keywords: string[];
    let route: ListingJobSpecV1['route'];
    let marketSelection = null;
    if (input.keyword?.trim()) {
      route = 'keyword'; keywords = [input.keyword.trim()];
    } else {
      route = 'market_selection';
      marketSelection = await runMarketSelection({
        batch_id: input.batch_id,
        snapshot_path: input.market_snapshot_path ?? path.resolve('data/ozon/category-analytics/raw/ozon-category-year-2026-06-17.json'),
        category_count: input.category_count ?? Math.min(8, Math.max(5, input.requested_listing_count)),
        daily_listing_limit: input.requested_listing_count,
        max_sku_per_product: input.max_sku_per_product,
      });
      keywords = [...new Set(marketSelection.selected_categories.map((category) => category.search_keyword_1688_zh))];
    }
    const keywordListingTargets = marketSelection
      ? marketSelection.selected_categories.reduce<Record<string, number>>((targets, category) => {
          targets[category.search_keyword_1688_zh] = (targets[category.search_keyword_1688_zh] ?? 0) + category.planned_listings;
          return targets;
        }, {})
      : { [keywords[0]!]: input.requested_listing_count };
    const spec: ListingJobSpecV1 = {
      schema_version: 1, batch_id: input.batch_id, store_id: input.store_id, route,
      requested_listing_count: input.requested_listing_count, keywords, keyword_listing_targets: keywordListingTargets, created_at: createdAt,
      collection: { profiles: input.profiles, attempts_per_account: 3, headed: input.headed,
        captcha_policy: input.captcha_policy, max_sku_per_product: input.max_sku_per_product,
        price_min_cny: input.price_min_cny, price_max_cny: input.price_max_cny, candidate_limit: input.candidate_limit },
      images: { generate: input.generate_images === true },
    };
    const result = await createListingBatch(spec, store);
    if (marketSelection) await store.writeMarketSelection(input.batch_id, marketSelection);
    await jobStore.upsertJob(spec, result);
    return { ok: true, command: 'workflow.batch.create', data: result, warnings: [], errors: [],
      nextActions: ['Current Agent should run or resume this foreground batch and supply category, attribute, content, and weight decisions when requested.'] };
  } catch (error) {
    const code = error instanceof Error && /^[A-Z][A-Z0-9_]+$/u.test(error.message) ? error.message : 'BATCH_CREATE_FAILED';
    return { ok: false, command: 'workflow.batch.create', warnings: [], errors: [{ code, message: error instanceof Error ? error.message : String(error), recoverable: false }], nextActions: [] };
  } finally { if (ownsJobStore) await jobStore.close(); }
}

export async function getBatchWorkflowStatus(batchId: string, store = new FileBatchStore()): Promise<CommandResult<ListingBatchResultV1>> {
  try {
    return { ok: true, command: 'workflow.batch.status', data: await store.readResult(batchId), warnings: [], errors: [], nextActions: [] };
  } catch (error) {
    return { ok: false, command: 'workflow.batch.status', warnings: [], errors: [{ code: 'BATCH_NOT_FOUND', message: error instanceof Error ? error.message : String(error), recoverable: false }], nextActions: [] };
  }
}

export async function submitBatchAgentInput(input: { batch_id: string; offer_id: string; kind: AgentInputKindV1; value: unknown; store?: FileBatchStore }): Promise<CommandResult<{ saved: true }>> {
  try {
    const store = input.store ?? new FileBatchStore();
    await store.readSpec(input.batch_id);
    await store.writeAgentInput(input.batch_id, input.offer_id, input.kind, input.value);
    return { ok: true, command: 'workflow.batch.agent-input', data: { saved: true }, warnings: [], errors: [], nextActions: ['Run workflow batch resume.'] };
  } catch (error) { return failure('workflow.batch.agent-input', error); }
}

export async function runBatchWorkflow(input: { batch_id: string; store?: FileBatchStore; job_store?: PublishReliabilityStore & WorkflowJobStateStore; signal?: AbortSignal }): Promise<CommandResult<ListingBatchResultV1>> {
  const store = input.store ?? new FileBatchStore();
  const jobStore = input.job_store ?? new SqliteJobStore();
  const ownsJobStore = !input.job_store;
  try {
    const spec = await store.readSpec(input.batch_id);
    const storeProfile = new FileStoreRegistry().get(spec.store_id);
    if (!storeProfile.publishing.enabled) throw new Error('STORE_PUBLISHING_DISABLED');
    await assertActiveBatchConsent(jobStore, storeProfile.store_id, hashWorkflowValue(storeProfile));
    const configuredImages = spec.images?.generate ? await loadConfiguredImageGeneration() : null;
    const marketSelection = await store.readMarketSelection(input.batch_id);
    const result = await runListingBatch({
      batch_id: input.batch_id, store, signal: input.signal,
      candidate_provider: { candidates: async (keyword, limit, signal) => {
        const searched = await collectWithAccountFailover(spec.collection.profiles, (profile) => searchKeywordCandidateIds({
          keyword, max: limit, profile, headed: spec.collection.headed,
          filters: { priceMin: spec.collection.price_min_cny, priceMax: spec.collection.price_max_cny },
        }), 3, { stop_on_error_codes: spec.collection.captcha_policy === 'pause' ? ['RISK_CONTROL'] : [] });
        if (searched.status === 'stopped') throw Object.assign(new Error(searched.final_error_code ?? 'RISK_CONTROL'), { code: searched.final_error_code, recoverable: true });
        if (searched.status !== 'succeeded') return [];
        return searched.value!.map((offerId) => ({ offer_id: offerId, keyword }));
      } },
      product_executor: { execute: async (candidate, options) => {
        const category = await store.readAgentInput<CategoryDecisionV1>(input.batch_id, candidate.offer_id, 'category');
        const pricing = await store.readAgentInput<CostPricingAgentInputV1>(input.batch_id, candidate.offer_id, 'pricing');
        const attributes = await store.readAgentInput<AttributeMappingAgentInputV1>(input.batch_id, candidate.offer_id, 'attributes');
        const images = await store.readAgentInput<ImageReviewAgentInputV1>(input.batch_id, candidate.offer_id, 'images');
        const prepared = await runListingPreparation({
          run_id: options.run_id,
          store_id: spec.store_id,
          source: { mode: 'offers', offerIds: [candidate.offer_id], profile: options.profile, headed: spec.collection.headed },
          category_decision_provider: category ? new AgentDecisionProvider(async () => category) : undefined,
          cost_pricing_profile: {
            transport: storeProfile.logistics?.service_mode ?? 'land', sales_unit_quantity: 1,
            pricing_mode: storeProfile.pricing.mode,
            pricing_multiplier: Number(storeProfile.pricing.multiplier ?? '2'),
            retained_target_percent: Number(storeProfile.pricing.target_margin_percent ?? '0'),
            label_fee_cny: Number(storeProfile.pricing.label_fee_cny), domestic_shipping_cny: 0,
            other_fixed_cny: Number(storeProfile.pricing.other_fixed_cny),
            other_rate_percent: Number(storeProfile.pricing.other_rate_percent),
            advertising_reserve_percent: Number(storeProfile.pricing.advertising_reserve_percent),
            return_loss_reserve_percent: Number(storeProfile.pricing.return_loss_reserve_percent),
          },
          cost_pricing_agent_input: pricing ?? undefined,
          attribute_mapping_agent_input: attributes ?? undefined,
          image_review_agent_input: images ?? undefined,
          image_generation: configuredImages?.options,
          image_generation_provider: configuredImages?.provider,
          qualification: {
            max_sku_per_product: Math.min(spec.collection.max_sku_per_product, options.remaining_listing_capacity),
            price_min_cny: spec.collection.price_min_cny,
            price_max_cny: spec.collection.price_max_cny,
            require_image: true,
          },
          stop_on_review: true,
          job_state_store: jobStore,
          job_id: input.batch_id,
          offer_id: candidate.offer_id,
        });
        if (!prepared.data) throw workflowError(prepared.errors[0]?.code ?? 'PRODUCT_WORKFLOW_FAILED', prepared.errors[0]?.recoverable ?? false);
        if (prepared.data.category_decision) {
          const selected = marketSelection?.selected_categories.find((item) => item.search_keyword_1688_zh === candidate.keyword) ?? null;
          const firstGroup = prepared.data.category_decision.category_groups[0];
          const closure = validateCategoryClosure(selected, prepared.data.category_decision,
            firstGroup?.rationale_zh ? { rationale_zh: firstGroup.rationale_zh, confidence: firstGroup.confidence } : undefined);
          await store.writeCategoryClosure(input.batch_id, candidate.offer_id, closure);
          if (closure.some((item) => item.status === 'blocked')) throw workflowError('CATEGORY_CLOSURE_BLOCKED', false);
          if (closure.some((item) => item.status === 'needs_review')) return { run_id: options.run_id, listing_count: 0, status: 'paused' };
        }
        if (prepared.data.status === 'needs_review') return { run_id: options.run_id, listing_count: 0, status: 'paused' };
        if (prepared.data.status === 'blocked' || !prepared.ok) {
          const firstError = prepared.errors[0];
          const retryWithAnotherAccount = prepared.data.stopped_after === 'source-1688' && firstError?.recoverable === true;
          throw workflowError(firstError?.code ?? 'PRODUCT_WORKFLOW_BLOCKED', retryWithAnotherAccount);
        }
        const draftCount = prepared.data.listing_draft?.status === 'draft_complete' ? prepared.data.listing_draft.items.length : 0;
        if (draftCount === 0) return { run_id: options.run_id, listing_count: 0, status: 'paused' };
        const published = await runListingPublish({ run_id: options.run_id, store_id: spec.store_id, reliability_store: jobStore });
        const successful = published.data?.sku_results.filter((item) =>
          (item.status === 'imported' || item.status === 'skipped') && item.product_id !== null).length ?? 0;
        if (published.data?.status === 'polling_timeout') {
          return { run_id: options.run_id, listing_count: successful, status: 'paused' };
        }
        if (!published.data || (!published.ok && successful === 0)) {
          throw workflowError(published.errors[0]?.code ?? 'PRODUCT_PUBLISH_FAILED', false);
        }
        const failed = published.data.sku_results.some((item) => item.status === 'failed');
        return { run_id: options.run_id, listing_count: successful, status: failed ? 'partial_failed' : 'succeeded' };
      } },
    });
    await jobStore.upsertBatchResult(result);
    return { ok: true, command: 'workflow.batch.run', data: result, warnings: [], errors: [],
      nextActions: result.status === 'paused' ? ['Inspect each paused product run, submit current-Agent decisions, then resume.'] : [] };
  } catch (error) { return failure('workflow.batch.run', error); }
  finally { if (ownsJobStore) await jobStore.close(); }
}

async function assertActiveBatchConsent(store: PublishReliabilityStore, storeId: string, profileHash: string): Promise<void> {
  const consent = await store.getActiveConsent(storeId);
  if (!consent) throw new Error('STORE_PUBLISHING_CONSENT_REQUIRED');
  if (!consent.enabled || consent.revoked_at !== null) throw new Error('STORE_PUBLISHING_CONSENT_REVOKED');
  if (consent.store_id !== storeId) throw new Error('STORE_PUBLISHING_CONSENT_STORE_MISMATCH');
  if (consent.profile_hash !== profileHash) throw new Error('STORE_PUBLISHING_CONSENT_PROFILE_CHANGED');
}

function workflowError(code: string, recoverable: boolean): Error & { code: string; recoverable: boolean } {
  return Object.assign(new Error(code), { code, recoverable });
}
function failure(command: string, error: unknown): CommandResult<never> {
  const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : error instanceof Error && /^[A-Z][A-Z0-9_]+$/u.test(error.message) ? error.message : 'BATCH_WORKFLOW_FAILED';
  return { ok: false, command, warnings: [], errors: [{ code, message: error instanceof Error ? error.message : String(error), recoverable: true }], nextActions: [] };
}
