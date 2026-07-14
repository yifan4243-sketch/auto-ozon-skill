import type { OzonImportItemV1, OzonPublishErrorV1 } from '@auto-ozon/contracts';

export interface OzonSellerCredentials {
  client_id: string;
  api_key: string;
}

export interface OzonImportStatusItem {
  offer_id: string;
  product_id: number;
  status: 'pending' | 'imported' | 'failed' | 'skipped';
  errors: OzonPublishErrorV1[];
}

export interface OzonProductIdentity {
  offer_id: string;
  product_id: number;
  sku: number;
}

export interface OzonSellerWriteTransport {
  importProducts(items: OzonImportItemV1[], signal?: AbortSignal): Promise<number>;
  getImportInfo(taskId: number, signal?: AbortSignal): Promise<OzonImportStatusItem[]>;
  getProductIdentities(offerIds: string[], signal?: AbortSignal): Promise<OzonProductIdentity[]>;
}

export class HttpOzonSellerWriteTransport implements OzonSellerWriteTransport {
  constructor(
    private readonly credentials: OzonSellerCredentials,
    private readonly baseUrl = 'https://api-seller.ozon.ru',
    private readonly fetcher: typeof fetch = fetch,
  ) {
    if (!credentials.client_id || !credentials.api_key) throw new Error('Ozon Client-Id and Api-Key are required.');
  }

  async importProducts(items: OzonImportItemV1[], signal?: AbortSignal): Promise<number> {
    const body = await this.post('/v3/product/import', { items }, signal);
    const taskId = record(record(body).result).task_id;
    if (!Number.isInteger(taskId) || Number(taskId) <= 0) throw new Error('Ozon import response has no valid task_id.');
    return Number(taskId);
  }

  async getImportInfo(taskId: number, signal?: AbortSignal): Promise<OzonImportStatusItem[]> {
    const body = await this.post('/v1/product/import/info', { task_id: taskId }, signal);
    const items = record(record(body).result).items;
    if (!Array.isArray(items)) throw new Error('Ozon import info response has no items array.');
    return items.map((item) => {
      const value = record(item);
      const status = value.status;
      if (!['pending', 'imported', 'failed', 'skipped'].includes(String(status))) throw new Error('Ozon returned an unknown import status.');
      return {
        offer_id: String(value.offer_id ?? ''), product_id: Number(value.product_id ?? 0),
        status: status as OzonImportStatusItem['status'],
        errors: Array.isArray(value.errors) ? value.errors.map(normalizeError) : [],
      };
    });
  }

  async getProductIdentities(offerIds: string[], signal?: AbortSignal): Promise<OzonProductIdentity[]> {
    const body = await this.post('/v3/product/info/list', { offer_id: offerIds }, signal);
    const items = record(body).items;
    if (!Array.isArray(items)) return [];
    return items.map((item) => {
      const value = record(item);
      return { offer_id: String(value.offer_id ?? ''), product_id: Number(value.id ?? 0), sku: Number(value.sku ?? 0) };
    }).filter((item) => item.offer_id && item.product_id > 0 && item.sku > 0);
  }

  private async post(endpoint: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    const response = await this.fetcher(`${this.baseUrl}${endpoint}`, {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'Client-Id': this.credentials.client_id, 'Api-Key': this.credentials.api_key },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const error = new Error(`Ozon Seller API ${endpoint} returned HTTP ${response.status}.`);
      (error as Error & { status?: number }).status = response.status;
      throw error;
    }
    return response.json();
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Unexpected Ozon Seller API response.');
  return value as Record<string, unknown>;
}
function normalizeError(value: unknown): OzonPublishErrorV1 {
  const item = record(value);
  return {
    code: String(item.code ?? 'OZON_IMPORT_ERROR'), message: String(item.description ?? item.message ?? 'Ozon import failed.'),
    state: typeof item.state === 'string' ? item.state : undefined,
    level: typeof item.level === 'string' ? item.level : undefined,
    field: typeof item.field === 'string' ? item.field : undefined,
    attribute_id: typeof item.attribute_id === 'number' ? item.attribute_id : undefined,
    attribute_name: typeof item.attribute_name === 'string' ? item.attribute_name : undefined,
  };
}
