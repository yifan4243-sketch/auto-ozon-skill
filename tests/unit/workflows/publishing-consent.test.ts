import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileStoreRegistry } from '../../../packages/config/src/index.js';
import { SqliteJobStore } from '../../../packages/job-store/src/index.js';
import { setStorePublishingConsent } from '../../../packages/workflows/src/index.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

describe('explicit store publishing consent', () => {
  it('creates consent only through explicit enable and revokes it on disable', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-ozon-consent-'));
    roots.push(root);
    const configFile = path.join(root, 'data', 'config', 'ozon-stores.local.json');
    await fs.mkdir(path.dirname(configFile), { recursive: true });
    await fs.writeFile(configFile, JSON.stringify([profile(false)]), 'utf8');
    const registry = new FileStoreRegistry(configFile);
    const store = new SqliteJobStore(path.join(root, 'data', 'state', 'state.sqlite'));
    try {
      expect(store.getActiveConsent('525')).toBeNull();
      const enabled = await setStorePublishingConsent({
        store_id: '525', enabled: true, actor: 'owner', source: 'setup_cli', repo_root: root,
        registry, reliability_store: store,
      });
      expect(enabled).toMatchObject({ ok: true, data: { store_id: '525', enabled: true, actor: 'owner', revoked_at: null } });
      expect(registry.get('525').publishing.enabled).toBe(true);
      expect(store.getActiveConsent('525')).toMatchObject({ consent_id: enabled.data?.consent_id });

      const disabled = await setStorePublishingConsent({
        store_id: '525', enabled: false, actor: 'owner', source: 'setup_cli', repo_root: root,
        registry, reliability_store: store,
      });
      expect(disabled.ok).toBe(true);
      expect(registry.get('525').publishing.enabled).toBe(false);
      expect(store.getActiveConsent('525')).toBeNull();
    } finally {
      store.close();
    }
  });
});

function profile(enabled: boolean) {
  return {
    schema_version: 2 as const, store_id: '525', store_name: '店铺', market: 'RU' as const, currency_code: 'CNY' as const,
    credentials: { client_id: { provider: 'env' as const, key: 'OZON_CLIENT_ID_525' }, api_key: { provider: 'env' as const, key: 'OZON_API_KEY_525' } },
    publishing: { enabled, automation_level: 'automatic' as const, allowed_description_category_ids: [], max_items_per_batch: 100, daily_listing_limit: 100 },
    pricing: { mode: 'multiplier' as const, multiplier: '2', minimum_margin_percent: '0', advertising_reserve_percent: '0', return_loss_reserve_percent: '0', other_rate_percent: '10', label_fee_cny: '2', other_fixed_cny: '0' },
    polling: { timeout_ms: 60000, interval_ms: 1500, max_recoverable_retries: 2 as const },
  };
}
