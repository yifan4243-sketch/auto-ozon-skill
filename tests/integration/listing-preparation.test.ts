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
    const getAttributes = vi.fn(async () => ({ result: contentAttributes() }));
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
      cost_pricing_fx_rate: testFxRate(),
      cost_pricing_agent_input: testPricingAgentInput(),
      attribute_mapping_agent_input: testAttributeAgentInput(),
      stop_after: 'attribute-mapping',
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
      'cost-pricing': { status: 'succeeded' },
      'category-attributes': { status: 'succeeded' },
      'attribute-mapping': { status: 'succeeded' },
    });
    await expect(
      store.exists(runId, 'attribute-mapping', 'attribute-mapping-v2.json'),
    ).resolves.toBe(true);

    getAttributes.mockClear();
    const reused = await runListingPreparation({
      run_id: runId,
      start_from: 'canonicalize-product',
      category_decision_provider: new AgentDecisionProvider(async () => {
        throw new Error('completed decision must be reused');
      }),
      category_attributes: { transport },
      cost_pricing_fx_rate: testFxRate(),
      stop_after: 'attribute-mapping',
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
      cost_pricing_fx_rate: testFxRate(),
      attribute_mapping_agent_input: testAttributeAgentInput(),
      force_steps: ['category-attributes'],
      stop_after: 'attribute-mapping',
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

  it('stops for required pricing Agent input even when continue-on-review is enabled', async () => {
    const { store, runId } = await seededSourceRun();
    const result = await runListingPreparation({
      run_id: runId,
      start_from: 'canonicalize-product',
      category_decision_provider: decisionProvider(),
      cost_pricing_fx_rate: testFxRate(),
      stop_on_review: false,
      artifact_store: store,
    });
    expect(result).toMatchObject({
      ok: true,
      data: {
        status: 'needs_review',
        stopped_after: 'cost-pricing',
        cost_pricing: { status: 'needs_agent', agent_tasks: [{ source_sku_id: 'sku-1' }] },
      },
    });
  });

  it('rejects legacy manifests without moving or rewriting their artifacts', async () => {
    const { store, runId, root } = await seededSourceRun();
    const manifestPath = path.join(root, 'runs', runId, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as { schema_version: number };
    manifest.schema_version = 1;
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    const result = await runListingPreparation({
      run_id: runId,
      start_from: 'canonicalize-product',
      artifact_store: store,
    });
    expect(result).toMatchObject({
      ok: false,
      errors: [{ code: 'LEGACY_RUN_UNSUPPORTED' }],
    });
    await expect(fs.stat(path.join(root, 'runs', runId, '01-source', 'attempt-0001', 'offer-result.json'))).resolves.toBeTruthy();
  });

  it('returns a structured corruption error before accessing a damaged persisted product', async () => {
    const { store, runId, root } = await seededSourceRun();
    const prepared = await runListingPreparation({
      run_id: runId,
      start_from: 'canonicalize-product',
      stop_after: 'canonicalize-product',
      artifact_store: store,
    });
    expect(prepared.ok).toBe(true);
    const manifest = await store.readManifest(runId);
    const productArtifact = manifest!.steps['canonicalize-product'].artifacts.find((artifact) =>
      artifact.path.endsWith('/canonical-product-v2.json'))!;
    await fs.writeFile(path.join(root, 'runs', runId, productArtifact.path), '{"tampered":true}', 'utf8');

    const resumed = await runListingPreparation({
      run_id: runId,
      start_from: 'category-decision',
      stop_after: 'category-decision',
      category_decision_provider: decisionProvider(),
      artifact_store: store,
    });
    expect(resumed).toMatchObject({
      ok: false,
      errors: [{ code: 'CANONICAL_PRODUCT_ARTIFACT_CORRUPTED' }],
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
  return { store, runId, root };
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

function testFxRate() {
  return {
    provider: 'cbr' as const,
    cny_nominal: 1,
    rub_value: 10,
    rub_per_cny: 10,
    published_at: '2026-07-15T00:00:00.000Z',
    fetched_at: '2026-07-15T00:00:00.000Z',
    source_url: 'https://www.cbr.ru/scripts/XML_daily.asp',
    response_sha256: 'a'.repeat(64),
    cache_status: 'live' as const,
  };
}

function testPricingAgentInput() {
  return {
    source_offer_id: '123456789',
    sku_inputs: [{
      source_sku_id: 'sku-1',
      packaged_weight_g: 400,
      length_cm: 20,
      width_cm: 15,
      height_cm: 10,
      rationale: 'Integration fixture estimate.',
      evidence: ['fixture package dimensions'],
    }],
  };
}

function contentAttributes() {
  return [4180, 4191, 23171].map((id) => ({
    id,
    name: id === 4180 ? '名称' : id === 4191 ? '简介' : '#主题标签',
    description: '',
    type: 'String',
    is_required: false,
    is_collection: false,
    is_aspect: false,
    dictionary_id: 0,
    group_id: 1,
    group_name: '基本属性',
    category_dependent: true,
  }));
}

function testAttributeAgentInput() {
  const evidence = [{ source: 'canonical_v2' as const, field: 'product.title_zh', value: '加厚塑料收纳盒 家用透明整理箱' }];
  const paragraphs = Array.from({ length: 4 }, () =>
    'Контейнер для хранения описан по сохранённому названию поставщика как прозрачное изделие для домашней организации вещей без дополнительных неподтверждённых характеристик.');
  return {
    source_offer_id: '123456789',
    sku_inputs: [{
      source_sku_id: 'sku-1',
      attributes: [
        { attribute_id: 4180, values: [{ value: 'Прозрачный контейнер для хранения' }], confidence: 'high' as const, evidence },
        {
          attribute_id: 4191,
          values: [{ value: paragraphs.join('\n\n') }],
          confidence: 'high' as const,
          evidence,
          content_claims: paragraphs.map((claim_text) => ({ claim_text, evidence })),
        },
        {
          attribute_id: 23171,
          values: [{ value: Array.from({ length: 20 }, (_, index) => `#контейнер_${index + 1}`).join(' ') }],
          confidence: 'high' as const,
          evidence,
        },
      ],
    }],
  };
}
