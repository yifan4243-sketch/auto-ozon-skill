import type { SecretRefV1, StoreProfileV2 } from '@auto-ozon/contracts';

export interface SecretProvider {
  get(reference: SecretRefV1, purpose: string): string | null;
}

export class EnvSecretProvider implements SecretProvider {
  constructor(private readonly environment: Readonly<Record<string, string | undefined>>) {}

  get(reference: SecretRefV1, _purpose: string): string | null {
    if (reference.provider !== 'env') return null;
    const value = this.environment[reference.key];
    return typeof value === 'string' && value.length > 0 ? value : null;
  }
}

export interface ResolvedStoreCredentials {
  clientId: string;
  apiKey: string;
}

export function resolveStoreCredentials(
  profile: StoreProfileV2,
  provider: SecretProvider,
): ResolvedStoreCredentials {
  const clientId = provider.get(profile.credentials.client_id, `store:${profile.store_id}:client-id`);
  const apiKey = provider.get(profile.credentials.api_key, `store:${profile.store_id}:api-key`);
  if (!clientId || !apiKey) throw new Error('STORE_CREDENTIALS_MISSING');
  if (clientId !== profile.store_id) throw new Error('STORE_ID_CREDENTIAL_MISMATCH');
  return { clientId, apiKey };
}
