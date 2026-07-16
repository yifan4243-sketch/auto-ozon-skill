import { describe, expect, it } from 'vitest';
import { runListingSubmit } from '../../../../packages/steps/listing-submit/src/index.js';
import type { ListingDraftV1, SellerImportTransportV1 } from '../../../../packages/contracts/src/index.js';

const draft: ListingDraftV1 = { schema_version: 1, source_offer_id: '1688', status: 'draft_complete', warnings: [], errors: [], items: ['a', 'b'].map((offer_id) => ({ offer_id, name: 'Термокружка', price: '20.00', description_category_id: 1, type_id: 2, weight: 600, depth: 200, width: 100, height: 100, dimension_unit: 'mm', weight_unit: 'g', images: ['https://img.test/a.jpg'], primary_image: 'https://img.test/a.jpg', attributes: [], complex_attributes: [], currency_code: 'CNY' })) };
const profile = { store_id: '5', publishing: { enabled: true }, credentials: { client_id_env: 'X', api_key_env: 'Y' }, polling: { timeout_ms: 100, interval_ms: 0, max_recoverable_retries: 2 as const } };

describe('listing-submit', () => {
  it('submits draft items, polls, and records only API-confirmed product IDs', async () => {
    const transport: SellerImportTransportV1 = { submit: async () => ({ task_id: 'task-1' }), getImportInfo: async () => ({ complete: true, items: [{ offer_id: 'a', status: 'imported' }, { offer_id: 'b', status: 'imported' }] }), getProductsByOfferIds: async () => [{ offer_id: 'a', product_id: 11 }, { offer_id: 'b', product_id: 12 }] };
    const result = await runListingSubmit({ draft, profile, transport });
    expect(result).toMatchObject({ ok: true, data: { status: 'completed', task_ids: ['task-1'], sku_results: [{ offer_id: 'a', product_id: 11 }, { offer_id: 'b', product_id: 12 }] } });
  });

  it('retries only a failed SKU at most twice and preserves successful SKUs', async () => {
    const submissions: string[][] = []; let calls = 0;
    const transport: SellerImportTransportV1 = { submit: async (items) => { submissions.push(items.map((item) => item.offer_id)); return { task_id: `task-${submissions.length}` }; }, getImportInfo: async () => { calls += 1; return calls === 1 ? { complete: true, items: [{ offer_id: 'a', status: 'imported' }, { offer_id: 'b', status: 'failed', errors: ['temporary'] }] } : { complete: true, items: [{ offer_id: 'b', status: 'imported' }] }; }, getProductsByOfferIds: async () => [{ offer_id: 'a', product_id: 11 }, { offer_id: 'b', product_id: 12 }] };
    const result = await runListingSubmit({ draft, profile, transport });
    expect(submissions).toEqual([['a', 'b'], ['b']]); expect(result.data?.status).toBe('completed'); expect(result.data?.sku_results.find((item) => item.offer_id === 'b')?.retry_count).toBe(1);
  });

  it('blocks a non-publish-ready draft without calling the transport', async () => {
    const blocked = { ...draft, status: 'blocked' as const }; const transport: SellerImportTransportV1 = { submit: async () => { throw new Error('must not submit'); }, getImportInfo: async () => { throw new Error('must not poll'); }, getProductsByOfferIds: async () => [] };
    const result = await runListingSubmit({ draft: blocked, profile, transport });
    expect(result).toMatchObject({ ok: false, data: { status: 'blocked', errors: ['DRAFT_NOT_PUBLISH_READY'] } });
  });

  it('resumes an unfinished task by polling it before making another submission', async () => {
    const first: SellerImportTransportV1 = { submit: async () => ({ task_id: 'task-timeout' }), getImportInfo: async () => ({ complete: false, items: [] }), getProductsByOfferIds: async () => [] };
    const timedOut = await runListingSubmit({ draft, profile: { ...profile, polling: { ...profile.polling, timeout_ms: 0 } }, transport: first });
    let submitted = 0; let polled = 0;
    const resumed: SellerImportTransportV1 = { submit: async () => { submitted += 1; return { task_id: 'unexpected' }; }, getImportInfo: async () => { polled += 1; return { complete: true, items: [{ offer_id: 'a', status: 'imported' }, { offer_id: 'b', status: 'imported' }] }; }, getProductsByOfferIds: async () => [{ offer_id: 'a', product_id: 1 }, { offer_id: 'b', product_id: 2 }] };
    const result = await runListingSubmit({ draft, profile, transport: resumed, previous: timedOut.data! });
    expect(polled).toBeGreaterThan(0); expect(submitted).toBe(0); expect(result.data?.status).toBe('completed');
  });
});
