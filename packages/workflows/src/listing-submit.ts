import fs from 'node:fs';
import path from 'node:path';
import type { CommandResult, ListingDraftV1, OzonPublishResultV1, StorePublishProfileV1, WorkflowStepStatus } from '@auto-ozon/contracts';
import { FileArtifactStore, createFileWorkflowLogger, type ArtifactStore, type WorkflowContext } from '@auto-ozon/artifact-store';
import { OzonSellerImportClient } from '@auto-ozon/adapters-ozon';
import { loadOzonEnvironment } from '@auto-ozon/adapters-ozon';
import { runListingSubmit } from '@auto-ozon/step-listing-submit';

export interface ListingSubmitOptions { run_id: string; store_id: string; artifact_store?: ArtifactStore; }
export async function runListingPublish(options: ListingSubmitOptions): Promise<CommandResult<OzonPublishResultV1>> {
  const store = options.artifact_store ?? new FileArtifactStore(); const draft = await store.read<ListingDraftV1>(options.run_id, 'draft-generation', 'listing-draft-v1.json');
  if (!draft) return failed('LISTING_DRAFT_MISSING', 'A completed listing draft is required before publishing.');
  const profile = loadProfile(options.store_id); if (!profile.ok) return failed(profile.code, profile.message);
  const environment = loadOzonEnvironment();
  const clientId = environment[profile.value.credentials.client_id_env]; const apiKey = environment[profile.value.credentials.api_key_env];
  if (!clientId || !apiKey) return failed('STORE_CREDENTIALS_MISSING', 'Configured store credentials are missing from the environment.');
  if (clientId !== options.store_id) return failed('STORE_ID_CREDENTIAL_MISMATCH', 'The selected store ID does not match the configured Seller Client-Id.');
  const previous = await store.read<OzonPublishResultV1>(options.run_id, 'listing-submit', 'ozon-publish-result-v1.json');
  const context: WorkflowContext = { run_id: options.run_id, artifact_store: store, logger: createFileWorkflowLogger(store.runsRoot, options.run_id), force_refresh: false };
  return runListingSubmit({ draft, profile: profile.value, transport: new OzonSellerImportClient({ clientId, apiKey }), previous: previous ?? undefined }, context);
}

export async function getListingPublishStatus(runId: string, artifactStore: ArtifactStore = new FileArtifactStore()): Promise<CommandResult<OzonPublishResultV1>> {
  const value = await artifactStore.read<OzonPublishResultV1>(runId, 'listing-submit', 'ozon-publish-result-v1.json');
  return value ? { ok: value.status !== 'blocked' && value.status !== 'failed', command: 'listing.status', data: value, warnings: [], errors: [], nextActions: [] } : failed('PUBLISH_RESULT_MISSING', 'No listing-submit result exists for this run.');
}

function loadProfile(storeId: string): { ok: true; value: StorePublishProfileV1 } | { ok: false; code: string; message: string } {
  const file = path.join(process.cwd(), 'data', 'config', 'ozon-stores.local.json');
  if (!fs.existsSync(file)) return { ok: false, code: 'STORE_PROFILE_MISSING', message: 'Local store profile file is missing.' };
  try { const profiles = JSON.parse(fs.readFileSync(file, 'utf8')) as StorePublishProfileV1[]; const value = profiles.find((item) => item.store_id === storeId); return value ? { ok: true, value } : { ok: false, code: 'STORE_PROFILE_NOT_FOUND', message: 'No local publish profile matches this store ID.' }; } catch { return { ok: false, code: 'STORE_PROFILE_INVALID', message: 'Local store profile is not valid JSON.' }; }
}
function failed(code: string, message: string): CommandResult<never> { return { ok: false, command: 'listing.publish', warnings: [], errors: [{ code, message, recoverable: true }], nextActions: [] }; }
