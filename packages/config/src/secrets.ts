export interface ResolvedOzonCredentials { client_id: string; api_key: string }

export function resolveOzonCredentials(reference: string, env: NodeJS.ProcessEnv = process.env): ResolvedOzonCredentials {
  if (!/^[A-Za-z0-9_-]+$/.test(reference)) throw new Error('Invalid credentials reference.');
  const key = reference.toUpperCase().replace(/-/g, '_');
  const clientId = env[`AUTO_OZON_CREDENTIALS_${key}_CLIENT_ID`];
  const apiKey = env[`AUTO_OZON_CREDENTIALS_${key}_API_KEY`];
  if (!clientId || !apiKey) throw new Error(`Ozon credentials reference ${reference} is not configured.`);
  return { client_id: clientId, api_key: apiKey };
}
