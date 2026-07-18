import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CategoryDecisionV1, ListingJobSpecV1 } from '../../../packages/contracts/src/index.js';
import { createListingBatch, FileBatchStore, runListingBatch, validateCategoryClosure } from '../../../packages/batch-orchestrator/src/index.js';

const temporaryDirectories: string[] = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((item) => fs.rm(item, { recursive: true, force: true }))));

describe('batch orchestrator', () => {
  it('uses independent product runs, skips after six failures and continues replenishing', async () => {
    const store = await temporaryStore();
    const spec = jobSpec('skip_product');
    await createListingBatch(spec, store);
    const calls: string[] = [];
    const result = await runListingBatch({
      batch_id: spec.batch_id, store,
      candidate_provider: { candidates: async () => [
        { offer_id: '100001', keyword: '杯子' }, { offer_id: '100002', keyword: '杯子' },
      ] },
      product_executor: { execute: async (candidate, options) => {
        calls.push(`${candidate.offer_id}:${options.profile}:${options.attempt}`);
        if (candidate.offer_id === '100001') throw Object.assign(new Error('failed'), { code: 'COLLECTION_FAILED' });
        return { run_id: options.run_id, listing_count: 2 };
      } },
    });
    expect(result.status).toBe('completed');
    expect(result.succeeded_count).toBe(2);
    expect(result.skipped_count).toBe(1);
    expect(result.product_runs[0]).toMatchObject({ offer_id: '100001', attempts: 6, status: 'skipped' });
    expect(result.product_runs[1]?.run_id).toBe('batch-test-100002');
    expect(calls.slice(0, 6)).toEqual([
      '100001:account-1:1', '100001:account-1:2', '100001:account-1:3',
      '100001:account-2:1', '100001:account-2:2', '100001:account-2:3',
    ]);
  });

  it('pauses immediately on captcha when requested', async () => {
    const store = await temporaryStore();
    const spec = jobSpec('pause');
    await createListingBatch(spec, store);
    let calls = 0;
    const result = await runListingBatch({
      batch_id: spec.batch_id, store,
      candidate_provider: { candidates: async () => [{ offer_id: '100003', keyword: '杯子' }] },
      product_executor: { execute: async () => {
        calls += 1;
        throw Object.assign(new Error('captcha'), { code: 'RISK_CONTROL' });
      } },
    });
    expect(result.status).toBe('paused');
    expect(result.product_runs[0]).toMatchObject({ status: 'paused', attempts: 1 });
    expect(calls).toBe(1);
  });

  it('resumes an Agent-paused product without consuming another candidate slot', async () => {
    const store = await temporaryStore();
    const spec = jobSpec('skip_product');
    await createListingBatch(spec, store);
    const candidateProvider = { candidates: async () => [{ offer_id: '100004', keyword: '杯子' }] };
    const paused = await runListingBatch({ batch_id: spec.batch_id, store, candidate_provider: candidateProvider,
      product_executor: { execute: async (_candidate, options) => ({ run_id: options.run_id, listing_count: 0, status: 'paused' }) } });
    expect(paused).toMatchObject({ status: 'paused', candidate_count: 1, succeeded_count: 0, product_runs: [{ status: 'paused' }] });
    const resumed = await runListingBatch({ batch_id: spec.batch_id, store, candidate_provider: candidateProvider,
      product_executor: { execute: async (_candidate, options) => ({ run_id: options.run_id, listing_count: 2, status: 'succeeded' }) } });
    expect(resumed).toMatchObject({ status: 'completed', candidate_count: 1, succeeded_count: 2, product_runs: [{ status: 'succeeded' }] });
  });

  it('does not retry permanent business failures and continues the queue', async () => {
    const store = await temporaryStore();
    const spec = jobSpec('skip_product');
    await createListingBatch(spec, store);
    let permanentCalls = 0;
    const result = await runListingBatch({ batch_id: spec.batch_id, store,
      candidate_provider: { candidates: async () => [{ offer_id: '100005', keyword: '杯子' }, { offer_id: '100006', keyword: '杯子' }] },
      product_executor: { execute: async (candidate, options) => {
        if (candidate.offer_id === '100005') { permanentCalls += 1; throw Object.assign(new Error('CATEGORY_BLOCKED'), { code: 'CATEGORY_BLOCKED', recoverable: false }); }
        return { run_id: options.run_id, listing_count: 2, status: 'succeeded' };
      } },
    });
    expect(permanentCalls).toBe(1);
    expect(result).toMatchObject({ status: 'completed', failed_count: 1, succeeded_count: 2 });
  });
});

describe('category closure', () => {
  it('blocks unrelated market and final categories without an agent justification', () => {
    const result = validateCategoryClosure({
      analytics_category_id: 10, root_category_id: 1, root_category_name_zh: '家居', category_path_zh: '家居 > 杯子',
      search_keyword_1688_zh: '杯子', score: 80, metrics: { gmv: 1, items: 1, growth_percent: 1, seller_count: 1, buyout_percent: 80, leader_share_percent: 5 },
      seasonal_adjustment: 0, seasonal_reason_zh: '', rationale_zh: '', planned_listings: 1, candidate_collection_target: 2, max_sku_per_product: 3,
    }, decision('宠物用品', 20));
    expect(result[0]).toMatchObject({ relation: 'unrelated', status: 'blocked' });
  });
});

async function temporaryStore(): Promise<FileBatchStore> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-store-'));
  temporaryDirectories.push(root);
  return new FileBatchStore(root);
}

function jobSpec(captcha: 'pause' | 'skip_product'): ListingJobSpecV1 {
  return {
    schema_version: 1, batch_id: 'batch-test', store_id: '500000', route: 'keyword', requested_listing_count: 2,
    keywords: ['杯子'], keyword_listing_targets: { '杯子': 2 }, created_at: '2026-07-17T00:00:00.000Z',
    collection: { profiles: ['account-1', 'account-2'], attempts_per_account: 3, headed: false,
      captcha_policy: captcha, max_sku_per_product: 3, price_min_cny: 20, price_max_cny: 50, candidate_limit: 4 },
    images: { generate: false },
  };
}

function decision(pathName: string, categoryId: number): CategoryDecisionV1 {
  return {
    schema_version: 1, source_offer_id: '1', product_understanding: { summary_zh: '', product_family_zh: '', evidence: [] },
    representative_sku_ids: ['sku'], product_structure: 'single_sku', unassigned_sku_ids: [], warnings: [], errors: [], status: 'decided',
    category_groups: [{
      group_id: 'g', source_sku_ids: ['sku'], group_summary_zh: '', evidence: [],
      selected_category: { description_category_id: categoryId, description_category_name: pathName, type_id: 1, type_name: pathName, category_path_zh: [pathName] },
      alternative_categories: [], confidence: 'high', rationale_zh: '',
    }],
  };
}
