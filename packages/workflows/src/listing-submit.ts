import type { AttributeMappingV1, AuthorizationRecordV1, CategoryAttributesGroupV1, CommandResult, CostPricingV1, ListingDraftV1, OzonPublishResultV1, StoreProfileV2, StorePublishProfileV1 } from '@auto-ozon/contracts';
import { ArtifactStoreError, FileArtifactStore, createFileWorkflowLogger, hashWorkflowValue, type ArtifactStore, type WorkflowContext } from '@auto-ozon/artifact-store';
import { EnvSecretProvider, FileStoreRegistry, resolveStoreCredentials } from '@auto-ozon/config';
import { OzonSellerImportClient } from '@auto-ozon/adapters-ozon';
import { loadOzonEnvironment } from '@auto-ozon/adapters-ozon';
import { runListingSubmit, validatePublishPreflight, stableHash } from '@auto-ozon/step-listing-submit';
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
  const draft = await store.read<ListingDraftV1>(options.run_id, 'draft-generation', 'listing-draft-v1.json');
  if (!draft) return failed('LISTING_DRAFT_MISSING', 'A completed listing draft is required before publishing.');
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
  const manifest = await store.readManifest(options.run_id);
  await store.prepareStep(options.run_id, 'listing-submit', {
    input_hash: hashWorkflowValue({ store_id: options.store_id, draft }),
    dependency_hashes: manifest?.steps['draft-generation'].artifact
      ? { 'draft-generation': manifest.steps['draft-generation'].artifact.sha256 }
      : {},
    implementation_version: '1',
  });
  const pricing = await store.read<CostPricingV1>(options.run_id, 'cost-pricing', 'cost-pricing-v1.json');
  const attributes = await store.read<AttributeMappingV1>(options.run_id, 'attribute-mapping', 'attribute-mapping-v1.json');
  const categoryAttributes = await store.read<CategoryAttributesGroupV1[]>(options.run_id, 'category-attributes', 'category-attributes-v1.json');
  const preflight = validatePublishPreflight({ run_id: options.run_id, draft, store: storeProfile, pricing, attributes, category_attributes: categoryAttributes });
  await store.write(options.run_id, 'listing-submit', 'preflight-report-v1.json', preflight);
  if (preflight.status !== 'passed') return failed('PREFLIGHT_BLOCKED', 'Publish preflight failed. Read preflight-report-v1.json for exact checks.');
  const authorization: AuthorizationRecordV1 = {
    schema_version: 1, authorization_id: stableHash({ run_id: options.run_id, store_id: options.store_id, draft: preflight.draft_sha256, profile: storeProfile }).slice(0, 40),
    run_id: options.run_id, store_id: options.store_id, source: 'enabled_store_profile', automation_level: 'automatic',
    policy_version: 'automatic-publish-v1', profile_hash: stableHash(storeProfile), draft_sha256: preflight.draft_sha256,
    authorized_at: new Date().toISOString(),
  };
  await store.write(options.run_id, 'listing-submit', 'authorization-record-v1.json', authorization);
  const previous = await store.read<OzonPublishResultV1>(options.run_id, 'listing-submit', 'ozon-publish-result-v1.json');
  const context: WorkflowContext = { run_id: options.run_id, artifact_store: store, logger: createFileWorkflowLogger(store.runsRoot, options.run_id), force_refresh: false };
  const reliabilityStore = options.reliability_store ?? new SqliteJobStore();
  try {
    await reliabilityStore.createAuthorization(authorization);
    return await runListingSubmit({ draft, profile, transport: new OzonSellerImportClient({ clientId, apiKey }), previous: previous ?? undefined,
      run_id: options.run_id, preflight, reliability_store: reliabilityStore }, context);
  } finally {
    if (!options.reliability_store) await reliabilityStore.close();
  }
}

export async function getListingPublishStatus(runId: string, artifactStore: ArtifactStore = new FileArtifactStore()): Promise<CommandResult<OzonPublishResultV1>> {
  const value = await artifactStore.read<OzonPublishResultV1>(runId, 'listing-submit', 'ozon-publish-result-v1.json');
  return value ? { ok: value.status !== 'blocked' && value.status !== 'failed', command: 'listing.status', data: value, warnings: [], errors: [], nextActions: [] } : failed('PUBLISH_RESULT_MISSING', 'No listing-submit result exists for this run.');
}

function failed(code: string, message: string): CommandResult<never> { return { ok: false, command: 'listing.publish', warnings: [], errors: [{ code, message, recoverable: true }], nextActions: [] }; }
