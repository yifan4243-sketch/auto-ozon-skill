import type { ListingDraftItemV2, SellerImportInfoV1, SellerImportTransportV1 } from '@auto-ozon/contracts';

export interface OzonSellerApiErrorDetail {
  code: string;
  status: number | null;
  category: 'auth' | 'rate_limit' | 'network' | 'upstream_validation' | 'internal';
  recoverable: boolean;
  retry_after_ms: number | null;
  request_id: string | null;
  sanitized_response: unknown;
}

export class OzonSellerApiError extends Error {
  constructor(message: string, readonly detail: OzonSellerApiErrorDetail) {
    super(message);
    this.name = 'OzonSellerApiError';
  }
}

/** Fixed Seller API whitelist for listing-submit. It intentionally exposes no generic URL or operation argument. */
export class OzonSellerImportClient implements SellerImportTransportV1 {
  constructor(
    private readonly credentials: { clientId: string; apiKey: string },
    private readonly baseUrl = 'https://api-seller.ozon.ru',
    private readonly options: { timeoutMs?: number; fetch?: typeof fetch; signal?: AbortSignal; maxReadRetries?: number } = {},
  ) {}

  async submit(items: ListingDraftItemV2[]): Promise<{ task_id: string }> {
    const body = await this.post('/v3/product/import', { items }, true);
    const taskId = stringAt(body, ['task_id', 'result.task_id']);
    if (!taskId) throw new Error('Ozon import response did not contain task_id.');
    return { task_id: taskId };
  }

  async getImportInfo(taskId: string): Promise<SellerImportInfoV1> {
    const body = await this.post('/v1/product/import/info', { task_id: taskId }, false);
    const items = arrayAt(body, ['result.items', 'items']).map((item) => {
      const value = item as Record<string, unknown>;
      const errors = Array.isArray(value.errors) ? value.errors.map(formatImportError) : [];
      const statusText = String(value.status ?? value.status_name ?? '').toLowerCase();
      return {
        offer_id: String(value.offer_id ?? ''),
        status: errors.length > 0 || /fail|error/.test(statusText) ? 'failed' as const : /success|imported|created/.test(statusText) ? 'imported' as const : 'pending' as const,
        errors,
        recoverable: errors.length > 0 ? errors.every(isRecoverableImportError) : undefined,
      };
    }).filter((item) => item.offer_id);
    const complete = Boolean(valueAt(body, ['result.complete', 'complete'])) || items.every((item) => item.status !== 'pending');
    return { complete, items };
  }

  async getProductsByOfferIds(offerIds: string[]): Promise<Array<{ offer_id: string; product_id: number }>> {
    const body = await this.post('/v3/product/info/list', { offer_id: offerIds }, false);
    return arrayAt(body, ['items', 'result.items']).flatMap((item) => {
      const value = item as Record<string, unknown>; const productId = Number(value.id ?? value.product_id); const offerId = String(value.offer_id ?? '');
      return offerId && Number.isFinite(productId) ? [{ offer_id: offerId, product_id: productId }] : [];
    });
  }

  private async post(path: string, body: unknown, write: boolean): Promise<unknown> {
    const maxAttempts = Math.max(1, (this.options.maxReadRetries ?? 2) + 1);
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.postOnce(path, body);
      } catch (error) {
        lastError = error;
        const safelyRetryableWrite = write && error instanceof OzonSellerApiError && error.detail.category === 'rate_limit';
        if (!(error instanceof OzonSellerApiError) || !error.detail.recoverable || (write && !safelyRetryableWrite) || attempt >= maxAttempts) throw error;
        await abortableDelay(error.detail.retry_after_ms ?? Math.min(2_000, 200 * 2 ** (attempt - 1)), this.options.signal);
      }
    }
    throw lastError;
  }

  private async postOnce(path: string, body: unknown): Promise<unknown> {
    const controller = new AbortController();
    const externalAbort = () => controller.abort(this.options.signal?.reason);
    if (this.options.signal?.aborted) externalAbort();
    else this.options.signal?.addEventListener('abort', externalAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 30_000);
    try {
      const execute = this.options.fetch ?? fetch;
      const response = await execute(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Client-Id': this.credentials.clientId, 'Api-Key': this.credentials.apiKey },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const value = await response.json().catch(() => ({}));
      if (!response.ok) {
        const requestId = response.headers.get('x-request-id') ?? response.headers.get('request-id');
        const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
        throw new OzonSellerApiError(`Ozon ${path} failed with HTTP ${response.status}.`, {
          code: `OZON_HTTP_${response.status}`,
          status: response.status,
          category: response.status === 401 || response.status === 403 ? 'auth' : response.status === 429 ? 'rate_limit' : response.status >= 500 ? 'internal' : 'upstream_validation',
          recoverable: response.status === 429 || response.status >= 500,
          retry_after_ms: retryAfterMs,
          request_id: requestId,
          sanitized_response: sanitizeResponse(value),
        });
      }
      return value;
    } catch (error) {
      if (error instanceof OzonSellerApiError) throw error;
      const aborted = controller.signal.aborted;
      throw new OzonSellerApiError(aborted ? `Ozon ${path} timed out.` : `Ozon ${path} network request failed.`, {
        code: aborted ? 'OZON_REQUEST_TIMEOUT' : 'OZON_NETWORK_ERROR',
        status: null,
        category: 'network',
        recoverable: true,
        retry_after_ms: null,
        request_id: null,
        sanitized_response: null,
      });
    } finally {
      clearTimeout(timeout);
      this.options.signal?.removeEventListener('abort', externalAbort);
    }
  }
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('ABORTED'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, Math.max(0, milliseconds));
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(signal?.reason ?? new Error('ABORTED'));
    };
    function done(): void {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function formatImportError(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return String(value);
  const record = value as Record<string, unknown>;
  return [record.code, record.message, record.field].filter((part) => typeof part === 'string' && part).join(': ') || 'UNKNOWN_IMPORT_ERROR';
}

function isRecoverableImportError(value: string): boolean {
  return /(?:temporary|timeout|rate.?limit|too many|internal|unavailable|try again)/iu.test(value);
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function sanitizeResponse(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeResponse);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, /(?:key|token|secret|authorization|cookie)/iu.test(key) ? '[REDACTED]' : sanitizeResponse(entry)]));
}

function valueAt(value: unknown, paths: string[]): unknown { for (const path of paths) { let current: unknown = value; for (const key of path.split('.')) current = current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined; if (current !== undefined) return current; } return undefined; }
function stringAt(value: unknown, paths: string[]): string | null { const found = valueAt(value, paths); return typeof found === 'string' && found ? found : null; }
function arrayAt(value: unknown, paths: string[]): unknown[] { const found = valueAt(value, paths); return Array.isArray(found) ? found : []; }
