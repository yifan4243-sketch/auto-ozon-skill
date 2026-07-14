import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileArtifactStore } from '../../packages/artifact-store/src/index.js';
import type { OfferResult } from '../../packages/adapters-1688/src/index.js';
import { AgentDecisionProvider } from '../../packages/steps/category-decision/src/index.js';
import { runListingPreparation } from '../../packages/workflows/src/index.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('listing-preparation workflow', () => {
  it('runs canonical through attribute mapping and reuses completed artifacts', async () => {
    const { store, runId } = await seededSourceRun();
    const getAttributes = vi.fn(async () => ({ result: [] }));
    const transport = {
      getAttributes,
      getAttributeValuesPage: vi.fn(async () => ({ result: [], has_next: false })),
    };
    const provider = decisionProvider();

    const first = await runListingPreparation({
      run_id: runId,
      start_from: 'canonicalize-product',
      category_decision_provider: provider,
      category_attributes: { transport },
      stop_on_review: false,
      artifact_store: store,
    });

    expect(first.ok).toBe(true);
    expect(first.data).toMatchObject({
      run_id: runId,
      status: 'succeeded',
      stopped_after: 'attribute-mapping',
      attribute_mapping: { status: 'completed' },
    });
    expect(getAttributes).toHaveBeenCalledTimes(1);
    const manifest = await store.readManifest(runId);
    expect(manifest?.steps).toMatchObject({
      'source-1688': { status: 'succeeded' },
      'canonicalize-product': { status: 'needs_review' },
      'category-decision': { status: 'succeeded' },
      'category-attributes': { status: 'succeeded' },
      'attribute-mapping': { status: 'succeeded' },
    });
    await expect(
      store.exists(runId, 'attribute-mapping', 'attribute-mapping-v1.json'),
    ).resolves.toBe(true);

    getAttributes.mockClear();
    const reused = await runListingPreparation({
      run_id: runId,
      start_from: 'canonicalize-product',
      category_decision_provider: new AgentDecisionProvider(async () => {
        throw new Error('completed decision must be reused');
      }),
      category_attributes: { transport },
      stop_on_review: false,
      artifact_store: store,
    });
    expect(reused.ok).toBe(true);
    expect(getAttributes).not.toHaveBeenCalled();

    const refreshed = await runListingPreparation({
      run_id: runId,
      start_from: 'canonicalize-product',
      category_decision_provider: provider,
      category_attributes: { transport },
      force_steps: ['category-attributes'],
      stop_on_review: false,
      artifact_store: store,
    });
    expect(refreshed.ok).toBe(true);
    expect(getAttributes).toHaveBeenCalledTimes(1);
  });

  it('stops with needs_review when no category decision provider is available', async () => {
    const { store, runId } = await seededSourceRun();
    const result = await runListingPreparation({
      run_id: runId,
      start_from: 'canonicalize-product',
      stop_on_review: false,
      artifact_store: store,
    });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      status: 'needs_review',
      stopped_after: 'category-decision',
    });
    expect(result.nextActions[0]).toContain('category-decision');
  });

  it('rejects unknown steps outside the current workflow', async () => {
    const { store, runId } = await seededSourceRun();
    const result = await runListingPreparation({
      run_id: runId,
      start_from: 'canonicalize-product',
      stop_after: 'not-a-step' as never,
      artifact_store: store,
    });

    expect(result).toMatchObject({
      ok: false,
      errors: [{ code: 'STEP_NOT_ENABLED' }],
    });
  });
});

async function seededSourceRun() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-ozon-workflow-'));
  roots.push(root);
  const store = new FileArtifactStore({
    runsRoot: path.join(root, 'runs'),
    cacheRoot: path.join(root, 'cache'),
  });
  const runId = 'workflow-test';
  const offer = JSON.parse(
    await fs.readFile(
      new URL('../fixtures/1688/offer-result.json', import.meta.url),
      'utf8',
    ),
  ) as OfferResult;
  await store.ensureRun(runId);
  const output = await store.write(runId, 'source-1688', 'offer-result.json', {
    mode: 'offers',
    query: null,
    imagePath: null,
    details: {
      mode: 'offers',
      total: 1,
      success: 1,
      failed: 0,
      offerIds: [offer.offerId],
      offers: [offer],
      failures: [],
    },
  });
  await store.updateStep(runId, 'source-1688', { status: 'succeeded', output });
  return { store, runId };
}

function decisionProvider() {
  return new AgentDecisionProvider(async (product) => ({
    schema_version: 1,
    source_offer_id: product.source.offer_id,
    product_understanding: {
      summary_zh: '测试商品',
      product_family_zh: '智能手机壳',
      evidence: [{ source: 'title_zh', value: product.product.title_zh }],
    },
    representative_sku_ids: [product.skus[0]!.source_sku_id],
    product_structure: 'single_sku',
    category_groups: [{
      group_id: 'product',
      source_sku_ids: product.skus.map((sku) => sku.source_sku_id),
      group_summary_zh: '测试商品',
      evidence: [{ source: 'title_zh', value: product.product.title_zh }],
      selected_category: {
        description_category_id: 17028650,
        description_category_name: '保护套',
        type_id: 97011,
        type_name: '智能手机壳',
        category_path_zh: ['电子产品', '保护套', '智能手机壳'],
      },
      alternative_categories: [],
      confidence: 'high',
      rationale_zh: '测试使用已验证类目组合。',
    }],
    unassigned_sku_ids: [],
    status: 'decided',
    warnings: [],
    errors: [],
  }));
}
