import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AttributeMappingV2,
  CategoryAttributesGroupV1,
  ContentBundleV1,
  CostPricingV1,
  ImageBundleV1,
  ListingDraftV2,
  OutboxRecordV1,
  PreflightReportV1,
  PublishAuthorizationV1,
  PublishIntentV1,
  SellerImportTransportV1,
  StoreProfileV2,
  StorePublishingConsentV1,
} from '../../packages/contracts/src/index.js';
import type { OfferResult } from '../../packages/adapters-1688/src/index.js';
import { FileArtifactStore, hashWorkflowValue } from '../../packages/artifact-store/src/index.js';
import { EnvSecretProvider, FileStoreRegistry } from '../../packages/config/src/index.js';
import { SqliteJobStore } from '../../packages/job-store/src/index.js';
import { runImagePipeline } from '../../packages/image-pipeline/src/index.js';
import { AgentDecisionProvider } from '../../packages/steps/category-decision/src/index.js';
import { runListingSubmit, stableHash, validatePublishPreflight } from '../../packages/steps/listing-submit/src/index.js';
import { runListingPreparation, runListingPublish, setStorePublishingConsent } from '../../packages/workflows/src/index.js';

const roots: string[] = [];
const databases: SqliteJobStore[] = [];
afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('offline production V2 end-to-end', () => {
  it('prepares, submits, survives interruption, resumes by reconciliation, and never duplicates the product', async () => {
    const prepared = await prepareDraft();
    const { root, runId, store, draft } = prepared;
    const registryFile = path.join(root, 'data', 'config', 'ozon-stores.local.json');
    await writeJson(registryFile, [storeProfile(false)]);
    const registry = new FileStoreRegistry(registryFile);
    const secrets = new EnvSecretProvider({ OZON_CLIENT_ID_525: '525', OZON_API_KEY_525: 'fixture-seller-key' });
    const reliability = new SqliteJobStore(path.join(root, 'data', 'state', 'publish.sqlite'));
    databases.push(reliability);
    const consentResult = await setStorePublishingConsent({
      store_id: '525', enabled: true, actor: 'fixture-owner', source: 'setup_cli', repo_root: root,
      registry, reliability_store: reliability,
    });
    expect(consentResult).toMatchObject({ ok: true, data: { enabled: true, store_id: '525' } });

    let submitCount = 0;
    const firstTransport: SellerImportTransportV1 = {
      submit: async (items) => { submitCount += 1; expect(items).toEqual(draft.items); return { task_id: 'task-1' }; },
      getImportInfo: async () => ({ complete: false, items: [] }),
      getProductsByOfferIds: async () => [],
    };
    const interrupted = await runListingPublish({
      run_id: runId, store_id: '525', artifact_store: store, reliability_store: reliability,
      store_registry: registry, secret_provider: secrets, transport: firstTransport,
    });
    expect(interrupted).toMatchObject({ ok: true, data: { status: 'polling_timeout', task_ids: ['task-1'] } });
    expect(submitCount).toBe(1);

    let productReads = 0;
    const resumeTransport: SellerImportTransportV1 = {
      submit: async () => { submitCount += 1; throw new Error('resume must not submit again'); },
      getImportInfo: async (taskId) => {
        expect(taskId).toBe('task-1');
        return { complete: true, items: draft.items.map((item) => ({ offer_id: item.offer_id, status: 'imported' as const })) };
      },
      getProductsByOfferIds: async (offerIds) => {
        productReads += 1;
        return productReads === 1 ? [] : offerIds.map((offer_id, index) => ({ offer_id, product_id: 9000 + index }));
      },
    };
    const resumed = await runListingPublish({
      run_id: runId, store_id: '525', artifact_store: store, reliability_store: reliability,
      store_registry: registry, secret_provider: secrets, transport: resumeTransport,
    });
    expect(resumed).toMatchObject({
      ok: true,
      data: { status: 'completed', sku_results: [{ status: 'imported', product_id: 9000 }] },
    });
    expect(submitCount).toBe(1);
    expect(productReads).toBe(2);
    const intent = reliability.getIntent('525', draft.items[0]!.offer_id, stableHash(draft.items[0]!));
    expect(intent).toMatchObject({ status: 'succeeded', product_id: 9000 });
    const finalManifest = await store.readManifest(runId);
    expect(finalManifest?.steps['listing-submit'].status).toBe('succeeded');
    expect(draft.sku_bindings).toEqual([{ source_sku_id: 'sku-1', offer_id: draft.items[0]!.offer_id }]);
    expect(draft.artifact_hashes).toEqual({
      canonical_product_sha256: stableHash(prepared.product),
      category_decision_sha256: stableHash(prepared.categoryDecision),
      cost_pricing_sha256: stableHash(prepared.pricing),
      category_attributes_sha256: stableHash(prepared.categoryAttributes),
      attribute_mapping_sha256: stableHash(prepared.mapping),
      content_bundle_sha256: stableHash(prepared.content),
      image_bundle_sha256: stableHash(prepared.images),
    });

    await assertFailurePaths(prepared, registry, secrets, reliability, consentResult.data!);
  }, 30_000);

  it('classifies an unknown Ozon status as final failure and blocks an ambiguous pre-submit recovery', async () => {
    const prepared = await prepareDraft();
    const profile = storeProfile(true);
    const consent = consentFor(profile);
    const preflight = preflightFor(prepared, profile);
    const authorization = authorizationFor(prepared.runId, profile, consent, preflight);
    let submissions = 0;
    const unknown = await runListingSubmit({
      draft: prepared.draft,
      profile: publishProfile(profile),
      run_id: prepared.runId,
      preflight,
      consent,
      authorization,
      transport: {
        submit: async () => { submissions += 1; return { task_id: 'unknown-task' }; },
        getImportInfo: async () => ({
          complete: true,
          items: prepared.draft.items.map((item) => ({
            offer_id: item.offer_id, status: 'unexpected_remote_status', errors: ['OZON_UNKNOWN_STATUS'], recoverable: false,
          })) as never,
        }),
        getProductsByOfferIds: async () => [],
      },
    });
    expect(unknown).toMatchObject({ data: { status: 'partial_failed', sku_results: [{ status: 'failed', retry_count: 0 }] } });
    expect(submissions).toBe(1);

    const uncertainStore = new SqliteJobStore(path.join(prepared.root, 'data', 'state', 'uncertain.sqlite'));
    databases.push(uncertainStore);
    const item = prepared.draft.items[0]!;
    const now = new Date().toISOString();
    const intent: PublishIntentV1 = {
      schema_version: 1, intent_id: 'ambiguous-intent', run_id: 'crashed-run', store_id: profile.store_id,
      offer_id: item.offer_id, item_hash: stableHash(item), status: 'prepared', task_id: null, product_id: null,
      reconciliation_checks: 0, last_reconciliation_at: null, created_at: now, updated_at: now,
    };
    const outbox: OutboxRecordV1 = {
      schema_version: 1, outbox_id: 'ambiguous-outbox', intent_id: intent.intent_id, status: 'pending', attempts: 0,
      last_error_code: null, created_at: now, updated_at: now,
    };
    uncertainStore.prepareIntents([{ intent, outbox }]);
    let forbiddenSubmissions = 0;
    const ambiguous = await runListingSubmit({
      draft: prepared.draft, profile: publishProfile(profile), run_id: prepared.runId,
      preflight, consent, authorization, reliability_store: uncertainStore,
      transport: {
        submit: async () => { forbiddenSubmissions += 1; return { task_id: 'must-not-submit' }; },
        getImportInfo: async () => ({ complete: false, items: [] }),
        getProductsByOfferIds: async () => [],
      },
    });
    expect(ambiguous).toMatchObject({ data: { status: 'polling_timeout', warnings: ['PUBLISH_RECONCILIATION_REQUIRED'] } });
    expect(forbiddenSubmissions).toBe(0);
  }, 30_000);
});

async function assertFailurePaths(
  prepared: Awaited<ReturnType<typeof prepareDraft>>,
  registry: FileStoreRegistry,
  secrets: EnvSecretProvider,
  reliability: SqliteJobStore,
  activeConsent: StorePublishingConsentV1,
) {
  const profile = registry.get('525');
  const base = preflightInput(prepared, profile);

  const expiredCategories = structuredClone(prepared.categoryAttributes);
  expiredCategories[0]!.attributes_schema.snapshot.valid_to = '2000-01-01T00:00:00.000Z';
  const expired = validatePublishPreflight({ ...base, category_attributes: expiredCategories });
  expect(failedChecks(expired)).toContain('CATEGORY_SNAPSHOT_FRESH');

  const changedPricing = structuredClone(prepared.pricing);
  changedPricing.commission_snapshot_sha256 = 'f'.repeat(64);
  const commissionChanged = validatePublishPreflight({ ...base, pricing: changedPricing });
  expect(failedChecks(commissionChanged)).toContain('UPSTREAM_ARTIFACT_HASHES');

  const changedImages = structuredClone(prepared.images);
  changedImages.assets[0]!.content_sha256 = 'e'.repeat(64);
  const imageChanged = validatePublishPreflight({ ...base, images: changedImages });
  expect(failedChecks(imageChanged)).toContain('UPSTREAM_ARTIFACT_HASHES');

  const expiredTreeDraft = structuredClone(prepared.draft);
  expiredTreeDraft.category_tree_snapshot!.valid_to = '2000-01-01T00:00:00.000Z';
  const expiredTree = validatePublishPreflight({ ...base, draft: expiredTreeDraft });
  expect(failedChecks(expiredTree)).toEqual(expect.arrayContaining(['CATEGORY_TREE_SNAPSHOT_FRESH', 'CATEGORY_TREE_SNAPSHOT_MATCH']));

  expect(activeConsent.enabled).toBe(true);
  const revoked = await setStorePublishingConsent({
    store_id: '525', enabled: false, actor: 'fixture-owner', source: 'setup_cli', repo_root: prepared.root,
    registry, reliability_store: reliability,
  });
  expect(revoked.ok).toBe(true);
  let revokedSubmissions = 0;
  const revokedResult = await runListingPublish({
    run_id: prepared.runId, store_id: '525', artifact_store: prepared.store, reliability_store: reliability,
    store_registry: registry, secret_provider: secrets,
    transport: {
      submit: async () => { revokedSubmissions += 1; return { task_id: 'forbidden' }; },
      getImportInfo: async () => ({ complete: false, items: [] }), getProductsByOfferIds: async () => [],
    },
  });
  expect(revokedResult.errors[0]?.code).toBe('STORE_PUBLISHING_CONSENT_REQUIRED');
  expect(revokedSubmissions).toBe(0);

  const manifest = (await prepared.store.readManifest(prepared.runId))!;
  const draftArtifact = manifest.steps['draft-generation'].artifacts.find((entry) => entry.path.endsWith('/listing-draft-v2.json'))!;
  await fs.writeFile(path.join(prepared.root, 'runs', prepared.runId, draftArtifact.path), '{"tampered":true}\n', 'utf8');
  const corrupted = await runListingPublish({
    run_id: prepared.runId, store_id: '525', artifact_store: prepared.store, reliability_store: reliability,
    store_registry: registry, secret_provider: secrets,
    transport: { submit: async () => { throw new Error('must not submit'); }, getImportInfo: async () => ({ complete: false, items: [] }), getProductsByOfferIds: async () => [] },
  });
  expect(corrupted.errors[0]?.code).toBe('DRAFT_ARTIFACT_CORRUPTED');
}

async function prepareDraft() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-ozon-production-e2e-'));
  roots.push(root);
  const store = new FileArtifactStore({ runsRoot: path.join(root, 'runs'), cacheRoot: path.join(root, 'cache') });
  const runId = 'production-v2-e2e';
  const offer = JSON.parse(await fs.readFile(new URL('../fixtures/1688/offer-result.json', import.meta.url), 'utf8')) as OfferResult;
  await store.ensureRun(runId);
  const sourceOutput = await store.write(runId, 'source-1688', 'offer-result.json', {
    mode: 'offers', query: null, imagePath: null,
    details: { mode: 'offers', total: 1, success: 1, failed: 0, offerIds: [offer.offerId], offers: [offer], failures: [] },
  });
  await store.updateStep(runId, 'source-1688', { status: 'succeeded', output: sourceOutput });
  const prepared = await runListingPreparation({
    run_id: runId, start_from: 'canonicalize-product', stop_after: 'attribute-mapping', stop_on_review: false,
    category_decision_provider: categoryProvider(), category_attributes: { transport: attributeTransport() },
    cost_pricing_fx_rate: fxRate(), cost_pricing_agent_input: pricingAgentInput(),
    attribute_mapping_agent_input: attributeAgentInput(), artifact_store: store,
  });
  expect(prepared).toMatchObject({ ok: true, data: { status: 'succeeded', attribute_mapping: { status: 'completed' } } });
  const product = prepared.data!.product!;
  const png = pngFixture();
  const imageHash = createHash('sha256').update(png).digest('hex');
  const execute: typeof fetch = async () => new Response(png, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(png.length) } });
  const images = await runImagePipeline({
    product,
    fetch: execute,
    resolver: async () => ['93.184.216.34'],
    network: { allowed_hosts: ['img.example.com'], concurrency: 4, per_image_timeout_ms: 1000, total_timeout_ms: 5000 },
    agent_review: { source_offer_id: product.source.offer_id, assets: [{ content_sha256: imageHash, contains_chinese_text: false, contains_watermark: false, notes: 'Offline fixture review.' }] },
  });
  expect(images.status).toBe('completed');
  const drafted = await runListingPreparation({
    run_id: runId, start_from: 'draft-generation', stop_after: 'draft-generation', stop_on_review: false,
    image_bundle: images, artifact_store: store,
  });
  expect(drafted).toMatchObject({ ok: true, data: { status: 'succeeded', listing_draft: { status: 'draft_complete' } } });
  return {
    root, runId, store, draft: drafted.data!.listing_draft!, product: drafted.data!.product!,
    categoryDecision: drafted.data!.category_decision!, pricing: drafted.data!.cost_pricing!,
    categoryAttributes: drafted.data!.category_attributes!, mapping: drafted.data!.attribute_mapping!,
    content: drafted.data!.content_bundle!, images,
  };
}

function preflightFor(prepared: Awaited<ReturnType<typeof prepareDraft>>, profile: StoreProfileV2): PreflightReportV1 {
  const report = validatePublishPreflight(preflightInput(prepared, profile));
  expect(report.status).toBe('passed');
  return report;
}

function preflightInput(prepared: Awaited<ReturnType<typeof prepareDraft>>, profile: StoreProfileV2) {
  return {
    run_id: prepared.runId, draft: prepared.draft, store: profile, product: prepared.product,
    category_decision: prepared.categoryDecision, pricing: prepared.pricing, attributes: prepared.mapping,
    category_attributes: prepared.categoryAttributes, content: prepared.content, images: prepared.images,
    daily_succeeded_count: 0, pending_item_count: prepared.draft.items.length,
  };
}

function failedChecks(report: PreflightReportV1): string[] {
  return report.checks.filter((entry) => entry.status === 'failed').map((entry) => entry.code);
}

function categoryProvider() {
  return new AgentDecisionProvider(async (product) => ({
    schema_version: 1, source_offer_id: product.source.offer_id,
    product_understanding: { summary_zh: '透明收纳盒', product_family_zh: '智能手机壳', evidence: [{ source: 'title_zh', value: product.product.title_zh }] },
    representative_sku_ids: [product.skus[0]!.source_sku_id], product_structure: 'single_sku',
    category_groups: [{
      group_id: 'product', source_sku_ids: product.skus.map((sku) => sku.source_sku_id), group_summary_zh: '测试商品',
      evidence: [{ source: 'title_zh', value: product.product.title_zh }],
      selected_category: { description_category_id: 17028650, description_category_name: '保护套', type_id: 97011, type_name: '智能手机壳', category_path_zh: ['电子产品', '保护套', '智能手机壳'] },
      alternative_categories: [], confidence: 'high', rationale_zh: '固定离线测试类目。',
    }],
    unassigned_sku_ids: [], status: 'decided', warnings: [], errors: [],
  }));
}

function attributeTransport() {
  return {
    getAttributes: vi.fn(async () => ({ result: [4180, 4191, 23171].map((id) => ({
      id, name: id === 4180 ? '名称' : id === 4191 ? '简介' : '#主题标签', description: '', type: 'String',
      is_required: false, is_collection: false, is_aspect: false, dictionary_id: 0, group_id: 1, group_name: '基本属性', category_dependent: true,
    })) })),
    getAttributeValuesPage: vi.fn(async () => ({ result: [], has_next: false })),
  };
}

function fxRate() {
  return { provider: 'cbr' as const, cny_nominal: 1, rub_value: 10, rub_per_cny: 10,
    published_at: '2026-07-15T00:00:00.000Z', fetched_at: '2026-07-15T00:00:00.000Z',
    source_url: 'https://www.cbr.ru/scripts/XML_daily.asp', response_sha256: 'a'.repeat(64), cache_status: 'live' as const };
}

function pricingAgentInput() {
  return { source_offer_id: '123456789', sku_inputs: [{ source_sku_id: 'sku-1', packaged_weight_g: 400,
    length_cm: 20, width_cm: 15, height_cm: 10, rationale: 'Offline fixture estimate.', evidence: ['fixed fixture dimensions'] }] };
}

function attributeAgentInput() {
  const evidence = [{ source: 'canonical_v2' as const, field: 'product.title_zh', value: '加厚塑料收纳盒 家用透明整理箱' }];
  const paragraphs = Array.from({ length: 4 }, () => 'Контейнер для хранения описан по сохранённым фактам поставщика как прозрачное изделие для домашней организации вещей без дополнительных неподтверждённых характеристик.');
  return { source_offer_id: '123456789', sku_inputs: [{ source_sku_id: 'sku-1', attributes: [
    { attribute_id: 4180, values: [{ value: 'Прозрачный контейнер для хранения' }], confidence: 'high' as const, evidence },
    { attribute_id: 4191, values: [{ value: paragraphs.join('\n\n') }], confidence: 'high' as const, evidence,
      content_claims: paragraphs.map((claim_text) => ({ claim_text, evidence })) },
    { attribute_id: 23171, values: [{ value: Array.from({ length: 20 }, (_, index) => `#контейнер_${index + 1}`).join(' ') }], confidence: 'high' as const, evidence },
  ] }] };
}

function pngFixture(): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(256, 16);
  bytes.writeUInt32BE(256, 20);
  return bytes;
}

function storeProfile(enabled: boolean): StoreProfileV2 {
  return {
    schema_version: 2, store_id: '525', store_name: 'Offline fixture store', market: 'RU', currency_code: 'CNY',
    credentials: { client_id: { provider: 'env', key: 'OZON_CLIENT_ID_525' }, api_key: { provider: 'env', key: 'OZON_API_KEY_525' } },
    publishing: { enabled, automation_level: 'automatic', allowed_description_category_ids: [], max_items_per_batch: 100, daily_listing_limit: 100 },
    pricing: { mode: 'multiplier', multiplier: '2', minimum_margin_percent: '0', advertising_reserve_percent: '0', return_loss_reserve_percent: '0', other_rate_percent: '10', label_fee_cny: '2', other_fixed_cny: '0' },
    polling: { timeout_ms: 25, interval_ms: 0, max_recoverable_retries: 2 },
  };
}

function consentFor(profile: StoreProfileV2): StorePublishingConsentV1 {
  return { schema_version: 1, consent_id: 'direct-consent', store_id: profile.store_id, enabled: true, actor: 'fixture', source: 'setup_cli',
    created_at: '2026-07-18T00:00:00.000Z', revoked_at: null, profile_hash: hashWorkflowValue(profile), policy_version: 'automatic-publish-v1' };
}

function authorizationFor(runId: string, profile: StoreProfileV2, consent: StorePublishingConsentV1, preflight: PreflightReportV1): PublishAuthorizationV1 {
  return { schema_version: 1, authorization_id: 'direct-authorization', consent_id: consent.consent_id, run_id: runId,
    store_id: profile.store_id, profile_hash: consent.profile_hash, draft_sha256: preflight.draft_sha256, created_at: '2026-07-18T00:00:00.000Z' };
}

function publishProfile(profile: StoreProfileV2) {
  return { store_id: profile.store_id, publishing: { enabled: profile.publishing.enabled },
    credentials: { client_id_env: profile.credentials.client_id.key, api_key_env: profile.credentials.api_key.key }, polling: profile.polling };
}

async function writeJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
