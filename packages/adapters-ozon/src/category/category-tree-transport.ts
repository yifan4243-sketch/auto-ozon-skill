import { OzonSellerApiError } from '../seller-import-client.js';

export interface OzonCategoryTreeTransportV1 {
  getTree(signal?: AbortSignal): Promise<{ result: unknown[] }>;
}

/** Fixed read-only Seller API adapter for /v1/description-category/tree. */
export class OzonSellerCategoryTreeClient implements OzonCategoryTreeTransportV1 {
  constructor(
    private readonly credentials: { clientId: string; apiKey: string },
    private readonly baseUrl = 'https://api-seller.ozon.ru',
    private readonly options: { timeoutMs?: number; fetch?: typeof fetch } = {},
  ) {}

  async getTree(signal?: AbortSignal): Promise<{ result: unknown[] }> {
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 30_000);
    try {
      const response = await (this.options.fetch ?? fetch)(`${this.baseUrl}/v1/description-category/tree`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Client-Id': this.credentials.clientId, 'Api-Key': this.credentials.apiKey },
        body: JSON.stringify({ language: 'ZH_HANS' }),
        signal: controller.signal,
      });
      const value = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new OzonSellerApiError(`Ozon category tree failed with HTTP ${response.status}.`, {
          code: `OZON_HTTP_${response.status}`,
          status: response.status,
          category: response.status === 401 || response.status === 403 ? 'auth' : response.status === 429 ? 'rate_limit' : response.status >= 500 ? 'internal' : 'upstream_validation',
          recoverable: response.status === 429 || response.status >= 500,
          retry_after_ms: null,
          request_id: response.headers.get('x-request-id') ?? response.headers.get('request-id'),
          sanitized_response: null,
        });
      }
      if (!value || typeof value !== 'object' || !Array.isArray((value as { result?: unknown }).result)) {
        throw new Error('CATEGORY_TREE_RESPONSE_INVALID');
      }
      return value as { result: unknown[] };
    } catch (error) {
      if (error instanceof OzonSellerApiError || (error instanceof Error && error.message === 'CATEGORY_TREE_RESPONSE_INVALID')) throw error;
      throw new OzonSellerApiError(controller.signal.aborted ? 'Ozon category tree request timed out.' : 'Ozon category tree network request failed.', {
        code: controller.signal.aborted ? 'OZON_REQUEST_TIMEOUT' : 'OZON_NETWORK_ERROR',
        status: null, category: 'network', recoverable: true, retry_after_ms: null, request_id: null, sanitized_response: null,
      });
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }
}
