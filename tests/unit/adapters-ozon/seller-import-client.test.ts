import { describe, expect, it, vi } from 'vitest';
import { OzonSellerApiError, OzonSellerImportClient } from '../../../packages/adapters-ozon/src/seller-import-client.js';

describe('typed Ozon Seller import client', () => {
  it('classifies auth and rate-limit responses without exposing credentials', async () => {
    const authFetch = vi.fn(async () => response(403, { message: 'forbidden', api_key: 'echoed-secret' }, { 'x-request-id': 'req-1' }));
    const client = new OzonSellerImportClient({ clientId: '525', apiKey: 'secret' }, 'https://example.test', { fetch: authFetch as typeof fetch });
    await expect(client.submit([])).rejects.toMatchObject<OzonSellerApiError>({
      detail: { category: 'auth', recoverable: false, request_id: 'req-1', sanitized_response: { message: 'forbidden', api_key: '[REDACTED]' } },
    });

    const rateFetch = vi.fn(async () => response(429, {}, { 'retry-after': '2' }));
    const limited = new OzonSellerImportClient({ clientId: '525', apiKey: 'secret' }, 'https://example.test', { fetch: rateFetch as typeof fetch });
    await expect(limited.submit([])).rejects.toMatchObject({ detail: { category: 'rate_limit', recoverable: true, retry_after_ms: 2000 } });
  });

  it('aborts a request after the configured foreground timeout', async () => {
    const hanging = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))));
    const client = new OzonSellerImportClient({ clientId: '525', apiKey: 'secret' }, 'https://example.test', { timeoutMs: 1, fetch: hanging as typeof fetch });
    await expect(client.submit([])).rejects.toMatchObject({ detail: { code: 'OZON_REQUEST_TIMEOUT', recoverable: true } });
  });

  it('preserves structured import errors and explicit retry classification', async () => {
    const execute = vi.fn(async () => response(200, { result: { complete: true, items: [{ offer_id: 'a', status: 'failed', errors: [{ code: 'ATTRIBUTE_REQUIRED', message: 'missing field' }] }] } }));
    const client = new OzonSellerImportClient({ clientId: '525', apiKey: 'secret' }, 'https://example.test', { fetch: execute as typeof fetch });
    await expect(client.getImportInfo('task')).resolves.toEqual({ complete: true, items: [{ offer_id: 'a', status: 'failed', errors: ['ATTRIBUTE_REQUIRED: missing field'], recoverable: false }] });
  });
});

function response(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}
