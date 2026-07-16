import type { ListingDraftItemV1, SellerImportInfoV1, SellerImportTransportV1 } from '@auto-ozon/contracts';

/** Fixed Seller API whitelist for listing-submit. It intentionally exposes no generic URL or operation argument. */
export class OzonSellerImportClient implements SellerImportTransportV1 {
  constructor(private readonly credentials: { clientId: string; apiKey: string }, private readonly baseUrl = 'https://api-seller.ozon.ru') {}

  async submit(items: ListingDraftItemV1[]): Promise<{ task_id: string }> {
    const body = await this.post('/v3/product/import', { items });
    const taskId = stringAt(body, ['task_id', 'result.task_id']);
    if (!taskId) throw new Error('Ozon import response did not contain task_id.');
    return { task_id: taskId };
  }

  async getImportInfo(taskId: string): Promise<SellerImportInfoV1> {
    const body = await this.post('/v1/product/import/info', { task_id: taskId });
    const items = arrayAt(body, ['result.items', 'items']).map((item) => {
      const value = item as Record<string, unknown>;
      const errors = Array.isArray(value.errors) ? value.errors.map(String) : [];
      const statusText = String(value.status ?? value.status_name ?? '').toLowerCase();
      return { offer_id: String(value.offer_id ?? ''), status: errors.length > 0 || /fail|error/.test(statusText) ? 'failed' as const : /success|imported|created/.test(statusText) ? 'imported' as const : 'pending' as const, errors };
    }).filter((item) => item.offer_id);
    const complete = Boolean(valueAt(body, ['result.complete', 'complete'])) || items.every((item) => item.status !== 'pending');
    return { complete, items };
  }

  async getProductsByOfferIds(offerIds: string[]): Promise<Array<{ offer_id: string; product_id: number }>> {
    const body = await this.post('/v3/product/info/list', { offer_id: offerIds });
    return arrayAt(body, ['items', 'result.items']).flatMap((item) => {
      const value = item as Record<string, unknown>; const productId = Number(value.id ?? value.product_id); const offerId = String(value.offer_id ?? '');
      return offerId && Number.isFinite(productId) ? [{ offer_id: offerId, product_id: productId }] : [];
    });
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Client-Id': this.credentials.clientId, 'Api-Key': this.credentials.apiKey }, body: JSON.stringify(body) });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Ozon ${path} failed: ${response.status} ${JSON.stringify(value)}`);
    return value;
  }
}

function valueAt(value: unknown, paths: string[]): unknown { for (const path of paths) { let current: unknown = value; for (const key of path.split('.')) current = current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined; if (current !== undefined) return current; } return undefined; }
function stringAt(value: unknown, paths: string[]): string | null { const found = valueAt(value, paths); return typeof found === 'string' && found ? found : null; }
function arrayAt(value: unknown, paths: string[]): unknown[] { const found = valueAt(value, paths); return Array.isArray(found) ? found : []; }
