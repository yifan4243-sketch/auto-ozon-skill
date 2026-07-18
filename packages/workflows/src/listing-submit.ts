import type { AttributeMappingV2, AuthorizationRecordV1, CanonicalProductV2, CategoryAttributesGroupV1, CategoryDecisionV1, CommandResult, ContentBundleV1, CostPricingV1, ImageBundleV1, ListingDraftV2, OzonPublishResultV1, StoreProfileV2, StorePublishProfileV1 } from '@auto-ozon/contracts';
import { ArtifactStoreError, FileArtifactStore, createFileWorkflowLogger, hashWorkflowValue, type ArtifactStore, type WorkflowContext } from '@auto-ozon/artifact-store';
import { EnvSecretProvider, FileStoreRegistry, resolveStoreCredentials } from '@auto-ozon/config';
import { OzonSellerImportClient } from '@auto-ozon/adapters-ozon';
import { loadOzonEnvironment } from '@auto-ozon/adapters-ozon';
import { runListingSubmit, validatePublishPreflight, stableHash } from '@auto-ozon/step-listing-submit';
import { validateListingDraftArtifact } from '@auto-ozon/step-draft-generation';
import { SqliteJobStore, type PublishReliabilityStore } from '@auto-ozon/job-store';

export interface ListingSubmitOptions { run_id: string; store_id: string; artifact_store?: ArtifactStore; reliability_store?: PublishReliabilityStore; }
export async function runListingPublish(options: ListingSubmitOptions): Promise<CommandResult<OzonPublishResultV1>> {
  const store = options.artifact_store ?? new FileArtifactStore();
  try {
    return await store.withRunLock(options.run_id, () => runListingPublishLocked(options, store));
  } catch (error) {
    if (error instanceof ArtifactStoreError) return failed(error.code, error.message);
    return failed('LISTING_PUBLISH_FAILED', error instanceof Error ? error.message : String(error));
  }
}

async function runListingPublishLocked(options: ListingSubmitOptions, store: ArtifactStore): Promise<CommandResult<OzonPublishResultV1>> {
  const manifestBeforeDraft = await store.readManifest(options.run_id);
  const draftArtifactRecorded = Boolean(manifestBeforeDraft?.steps['draft-generation'].artifacts.some((artifact) =>
    artifact.path.endsWith('/listing-draft-v2.json')));
  const draftValue = await store.read<unknown>(options.run_id, 'draft-generation', 'listing-draft-v2.json');
  if (!draftValue) {
    if (draftArtifactRecorded) {
      return failed('DRAFT_ARTIFACT_CORRUPTED', 'The recorded ListingDraftV2 artifact is unreadable or its size/SHA-256 no longer matches the manifest.');
    }
    const legacy = await store.read<unknown>(options.run_id, 'draft-generation', 'listing-draft-v1.json');
    return legacy
      ? failed('LEGACY_DRAFT_CONTRACT_UNSUPPORTED', 'ListingDraftV1 is read-only and cannot be published. Start a new ListingDraftV2 run.')
      : failed('LISTING_DRAFT_MISSING', 'A completed ListingDraftV2 is required before publishing.');
  }
  const draftValidation = validateListingDraftArtifact(draftValue);
  if (!draftValidation.ok) {
    return failed(draftValidation.code, draftValidation.errors.join('; '));
  }
  const draft: ListingDraftV2 = draftValidation.value;
  let profile: StorePublishProfileV1;
  let storeProfile: StoreProfileV2;
  let clientId: string;
  let apiKey: string;
  try {
    storeProfile = new FileStoreRegistry().get(options.store_id);
    const credentials = resolveStoreCredentials(storeProfile, new EnvSecretProvider(loadOzonEnvironment()));
    ({ clientId, apiKey } = credentials);
    profile = {
      store_id: storeProfile.store_id,
      publishing: { enabled: storeProfile.publishing.enabled },
      credentials: {
        client_id_env: storeProfile.credentials.client_id.key,
        api_key_env: storeProfile.credentials.api_key.key,
      },
      polling: storeProfile.polling,
    };
    if (draft.items.some((item) => item.currency_code !== storeProfile.currency_code)) {
      return failed('STORE_CURRENCY_MISMATCH', 'Draft currency does not match the selected store profile.');
    }
  } catch (error) {
    const code = error instanceof Error ? error.message : 'STORE_PROFILE_INVALID';
    return failed(code, 'The selected local store profile or its credentials are invalid.');
  }
  const manifest = manifestBeforeDraft;
  await store.prepareStep(options.run_id, 'listing-submit', {
    input_hash: hashWorkflowValue({ store_id: options.store_id, draft }),
    dependency_hashes: manifest?.steps['draft-generation'].artifacts.length
      ? { 'draft-generation': hashWorkflowValue(manifest.steps['draft-generation'].artifacts.map((artifact) => ({ path: artifact.path, sha256: artifact.sha256 }))) }
      : {},
    implementation_version: '2',
  });
  // Every foreground publish/resume owns a new immutable attempt. This also
  // prevents a resume from overwriting preflight or result artifacts produced
  // by an earlier attempt with the same draft hash.
  await store.updateStep(options.run_id, 'listing-submit', { status: 'running' });
  const pricing = await store.read<CostPricingV1>(options.run_id, 'cost-pricing', 'cost-pricing-v1.json');
  const product = await store.read<CanonicalProductV2>(options.run_id, 'canonicalize-product', 'canonical-product-v2.json');
  const categoryDecision = await store.read<CategoryDecisionV1>(options.run_id, 'category-decision', 'category-decision-v1.json');
  const attributes = await store.read<AttributeMappingV2>(options.run_id, 'attribute-mapping', 'attribute-mapping-v2.json');
  const content = await store.read<ContentBundleV1>(options.run_id, 'attribute-mapping', 'content-bundle-v1.json');
  const categoryAttributes = await store.read<CategoryAttributesGroupV1[]>(options.run_id, 'category-attributes', 'category-attributes-v1.json');
  const images = await store.read<ImageBundleV1>(options.run_id, 'draft-generation', 'image-bundle-v1.json');
  const reliabilityStore = options.reliability_store ?? new SqliteJobStore();
  try {
    const dailySucceededCount = await reliabilityStore.countSucceededSince(options.store_id, startOfMoscowDayIso());
    let pendingItemCount = 0;
    for (const item of draft.items) {
      const prior = await reliabilityStore.getIntent(options.store_id, item.offer_id, stableHash(item));
      if (prior?.status !== 'succeeded') pendingItemCount += 1;
    }
    const preflight = validatePublishPreflight({ run_id: options.run_id, draft, store: storeProfile, product,
      category_decision: categoryDecision, pricing, attributes, content, images,
      category_attributes: categoryAttributes, daily_succeeded_count: dailySucceededCount, pending_item_count: pendingItemCount });
    const preflightOutput = await store.write(options.run_id, 'listing-submit', 'preflight-report-v1.json', preflight);
    if (preflight.status !== 'passed') {
      await store.updateStep(options.run_id, 'listing-submit', {
        status: 'blocked',
        output: preflightOutput,
        error: { code: 'PREFLIGHT_BLOCKED', message: 'Publish preflight failed.', recoverable: true },
      });
      return failed('PREFLIGHT_BLOCKED', 'Publish preflight failed. Read preflight-report-v1.json for exact checks.');
    }
    const authorization: AuthorizationRecordV1 = {
      schema_version: 1, authorization_id: stableHash({ run_id: options.run_id, store_id: options.store_id, draft: preflight.draft_sha256, profile: storeProfile }).slice(0, 40),
      run_id: options.run_id, store_id: options.store_id, source: 'enabled_store_profile', automation_level: 'automatic',
      policy_version: 'automatic-publish-v1', profile_hash: stableHash(storeProfile), draft_sha256: preflight.draft_sha256,
      authorized_at: new Date().toISOString(),
    };
    await store.write(options.run_id, 'listing-submit', 'authorization-record-v1.json', authorization);
    const previous = await store.read<OzonPublishResultV1>(options.run_id, 'listing-submit', 'ozon-publish-result-v1.json');
    const context: WorkflowContext = { run_id: options.run_id, artifact_store: store, logger: createFileWorkflowLogger(store.runsRoot, options.run_id), force_refresh: false };
    await reliabilityStore.createAuthorization(authorization);
    return await runListingSubmit({ draft, profile, transport: new OzonSellerImportClient({ clientId, apiKey }), previous: previous ?? undefined,
      run_id: options.run_id, preflight, authorization, reliability_store: reliabilityStore }, context);
  } finally {
    const latestManifest = await store.readManifest(options.run_id).catch(() => null);
    if (latestManifest && reliabilityStore.mirrorManifest) await reliabilityStore.mirrorManifest(latestManifest);
    if (!options.reliability_store) await reliabilityStore.close();
  }
}

function startOfMoscowDayIso(now = new Date()): string {
  const moscow = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  return new Date(Date.UTC(moscow.getUTCFullYear(), moscow.getUTCMonth(), moscow.getUTCDate()) - 3 * 60 * 60 * 1000).toISOString();
}

export async function getListingPublishStatus(runId: string, artifactStore: ArtifactStore = new FileArtifactStore()): Promise<CommandResult<OzonPublishResultV1>> {
  const value = await artifactStore.read<OzonPublishResultV1>(runId, 'listing-submit', 'ozon-publish-result-v1.json');
  return value ? { ok: value.status !== 'blocked' && value.status !== 'failed', command: 'listing.status', data: value, warnings: [], errors: [], nextActions: [] } : failed('PUBLISH_RESULT_MISSING', 'No listing-submit result exists for this run.');
}

function failed(code: string, message: string): CommandResult<never> { return { ok: false, command: 'listing.publish', warnings: [], errors: [{ code, message, recoverable: true }], nextActions: [] }; }
