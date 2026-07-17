import path from 'node:path';
import type { CommandResult, ListingBatchResultV1, ListingJobSpecV1 } from '@auto-ozon/contracts';
import { createListingBatch, FileBatchStore } from '@auto-ozon/batch-orchestrator';
import { runMarketSelection } from '@auto-ozon/market-selection';

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
  store?: FileBatchStore;
}

export async function createBatchWorkflow(input: CreateBatchWorkflowInputV1): Promise<CommandResult<ListingBatchResultV1>> {
  try {
    const store = input.store ?? new FileBatchStore();
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
        category_count: input.category_count, daily_listing_limit: input.requested_listing_count,
        max_sku_per_product: input.max_sku_per_product,
      });
      keywords = marketSelection.selected_categories.map((category) => category.search_keyword_1688_zh);
    }
    const spec: ListingJobSpecV1 = {
      schema_version: 1, batch_id: input.batch_id, store_id: input.store_id, route,
      requested_listing_count: input.requested_listing_count, keywords, created_at: createdAt,
      collection: { profiles: input.profiles, attempts_per_account: 3, headed: input.headed,
        captcha_policy: input.captcha_policy, max_sku_per_product: input.max_sku_per_product,
        price_min_cny: input.price_min_cny, price_max_cny: input.price_max_cny, candidate_limit: input.candidate_limit },
    };
    const result = await createListingBatch(spec, store);
    if (marketSelection) await store.writeMarketSelection(input.batch_id, marketSelection);
    return { ok: true, command: 'workflow.batch.create', data: result, warnings: [], errors: [],
      nextActions: ['Current Agent should run or resume this foreground batch and supply category, attribute, content, and weight decisions when requested.'] };
  } catch (error) {
    const code = error instanceof Error && /^[A-Z][A-Z0-9_]+$/u.test(error.message) ? error.message : 'BATCH_CREATE_FAILED';
    return { ok: false, command: 'workflow.batch.create', warnings: [], errors: [{ code, message: error instanceof Error ? error.message : String(error), recoverable: false }], nextActions: [] };
  }
}

export async function getBatchWorkflowStatus(batchId: string, store = new FileBatchStore()): Promise<CommandResult<ListingBatchResultV1>> {
  try {
    return { ok: true, command: 'workflow.batch.status', data: await store.readResult(batchId), warnings: [], errors: [], nextActions: [] };
  } catch (error) {
    return { ok: false, command: 'workflow.batch.status', warnings: [], errors: [{ code: 'BATCH_NOT_FOUND', message: error instanceof Error ? error.message : String(error), recoverable: false }], nextActions: [] };
  }
}
