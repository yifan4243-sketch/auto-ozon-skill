import path from 'node:path';
import type { CommandResult, StorePublishingConsentV1 } from '@auto-ozon/contracts';
import { hashWorkflowValue, resolveRepoRoot } from '@auto-ozon/artifact-store';
import { FileStoreRegistry } from '@auto-ozon/config';
import { SqliteJobStore, type PublishReliabilityStore } from '@auto-ozon/job-store';

export const AUTOMATIC_PUBLISH_POLICY_VERSION = 'automatic-publish-v1' as const;

export interface SetStorePublishingConsentInputV1 {
  store_id: string;
  enabled: boolean;
  actor: string;
  source: StorePublishingConsentV1['source'];
  repo_root?: string;
  registry?: FileStoreRegistry;
  reliability_store?: PublishReliabilityStore;
}

export async function setStorePublishingConsent(
  input: SetStorePublishingConsentInputV1,
): Promise<CommandResult<StorePublishingConsentV1 | null>> {
  const root = path.resolve(input.repo_root ?? resolveRepoRoot());
  const registry = input.registry ?? new FileStoreRegistry(path.join(root, 'data', 'config', 'ozon-stores.local.json'));
  const store = input.reliability_store ?? new SqliteJobStore(path.join(root, 'data', 'state', 'auto-ozon.sqlite'));
  const ownsStore = !input.reliability_store;
  try {
    if (!input.actor.trim()) return failure('CONSENT_ACTOR_REQUIRED', 'A non-empty actor is required for the publishing audit trail.');
    const profile = registry.updatePublishingEnabled(input.store_id, input.enabled);
    const now = new Date().toISOString();
    if (!input.enabled) {
      const revoked = await store.revokeConsent(input.store_id, input.actor.trim(), now);
      return success(revoked, 'publishing consent revoked');
    }
    const profileHash = hashWorkflowValue(profile);
    const active = await store.getActiveConsent(input.store_id);
    if (active?.profile_hash === profileHash && active.enabled && active.revoked_at === null) {
      return success(active, 'existing publishing consent remains active');
    }
    if (active) await store.revokeConsent(input.store_id, input.actor.trim(), now);
    const consent: StorePublishingConsentV1 = {
      schema_version: 1,
      consent_id: hashWorkflowValue({ store_id: input.store_id, profile_hash: profileHash, actor: input.actor.trim(), source: input.source, created_at: now }).slice(0, 40),
      store_id: input.store_id,
      enabled: true,
      actor: input.actor.trim(),
      source: input.source,
      created_at: now,
      revoked_at: null,
      profile_hash: profileHash,
      policy_version: AUTOMATIC_PUBLISH_POLICY_VERSION,
    };
    await store.createConsent(consent);
    return success(consent, 'publishing consent created');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'PUBLISHING_CONSENT_FAILED';
    const code = /^[A-Z][A-Z0-9_]+$/u.test(message) ? message : 'PUBLISHING_CONSENT_FAILED';
    return failure(code, 'The publishing setting and consent could not be updated safely.');
  } finally {
    if (ownsStore) await store.close();
  }
}

function success(data: StorePublishingConsentV1 | null, message: string): CommandResult<StorePublishingConsentV1 | null> {
  return { ok: true, command: 'setup.publishing', data, warnings: [], errors: [], nextActions: [message] };
}

function failure(code: string, message: string): CommandResult<never> {
  return { ok: false, command: 'setup.publishing', warnings: [], errors: [{ code, message, recoverable: true }], nextActions: [] };
}
