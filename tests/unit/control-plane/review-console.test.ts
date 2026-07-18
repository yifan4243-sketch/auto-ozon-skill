import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileStoreRegistry } from '../../../packages/config/src/index.js';
import { SqliteJobStore } from '../../../packages/job-store/src/index.js';
import { startReviewConsole } from '../../../packages/control-plane/src/index.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

describe('Local Review Console', () => {
  it('rejects the incomplete team deployment mode explicitly', async () => {
    await expect(startReviewConsole({ mode: 'team' } as never)).rejects.toThrow('REVIEW_CONSOLE_TEAM_MODE_UNSUPPORTED');
  });

  it('enforces local session, CSRF, body and path safety while creating explicit consent', async () => {
    const root = await createRoot();
    const running = await startReviewConsole({ repo_root: root, port: 0 });
    try {
      const landing = await fetch(running.url);
      const html = await landing.text();
      const cookie = landing.headers.get('set-cookie')!.split(';', 1)[0]!;
      const csrf = html.match(/name="csrf-token" content="([^"]+)"/u)?.[1];
      const nonce = html.match(/<script nonce="([^"]+)">/u)?.[1];
      expect(landing.status).toBe(200);
      expect(cookie).toMatch(/^auto_ozon_review=/u);
      expect(landing.headers.get('content-security-policy')).toContain(`script-src 'nonce-${nonce}'`);
      expect(landing.headers.get('content-security-policy')).not.toContain("'unsafe-inline'");
      expect(html).not.toContain('onclick=');
      expect(csrf).toBeTruthy();

      expect((await fetch(`${running.url}/api/overview`)).status).toBe(401);
      const overview = await fetch(`${running.url}/api/overview`, { headers: { cookie } });
      const overviewText = await overview.text();
      expect(overview.status).toBe(200);
      expect(overviewText).toContain('店铺');
      expect(overviewText).not.toContain('OZON_API_KEY_525');
      expect(overview.headers.get('content-security-policy')).toContain("default-src 'none'");

      const missingCsrf = await fetch(`${running.url}/api/stores/525/publishing`, {
        method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{"enabled":true}',
      });
      expect(missingCsrf.status).toBe(403);

      const enabled = await fetch(`${running.url}/api/stores/525/publishing`, {
        method: 'POST',
        headers: { cookie, origin: running.url, 'x-csrf-token': csrf!, 'content-type': 'application/json' },
        body: '{"enabled":true}',
      });
      expect(enabled.status).toBe(200);
      expect(new FileStoreRegistry(path.join(root, 'data', 'config', 'ozon-stores.local.json')).get('525').publishing.enabled).toBe(true);
      const state = new SqliteJobStore(path.join(root, 'data', 'state', 'auto-ozon.sqlite'));
      try { expect(state.getActiveConsent('525')).toMatchObject({ enabled: true, source: 'local_review_console' }); }
      finally { state.close(); }

      const oversized = await fetch(`${running.url}/api/stores/525/publishing`, {
        method: 'POST',
        headers: { cookie, origin: running.url, 'x-csrf-token': csrf!, 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false, padding: 'x'.repeat(1_000_001) }),
      });
      expect(oversized.status).toBe(413);
      expect((await fetch(`${running.url}/api/runs/..%2F..`, { headers: { cookie } })).status).toBe(404);
    } finally {
      await running.close();
    }
  });
});

async function createRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-ozon-review-console-'));
  roots.push(root);
  const file = path.join(root, 'data', 'config', 'ozon-stores.local.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify([profile()]), 'utf8');
  return root;
}

function profile() {
  return {
    schema_version: 2 as const, store_id: '525', store_name: '店铺', market: 'RU' as const, currency_code: 'CNY' as const,
    credentials: { client_id: { provider: 'env' as const, key: 'OZON_CLIENT_ID_525' }, api_key: { provider: 'env' as const, key: 'OZON_API_KEY_525' } },
    publishing: { enabled: false, automation_level: 'automatic' as const, allowed_description_category_ids: [], max_items_per_batch: 100, daily_listing_limit: 100 },
    pricing: { mode: 'multiplier' as const, multiplier: '2', minimum_margin_percent: '0', advertising_reserve_percent: '0', return_loss_reserve_percent: '0', other_rate_percent: '10', label_fee_cny: '2', other_fixed_cny: '0' },
    polling: { timeout_ms: 60000, interval_ms: 1500, max_recoverable_retries: 2 as const },
  };
}
