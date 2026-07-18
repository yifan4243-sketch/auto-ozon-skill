import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runSetupDoctor } from '../../../packages/workflows/src/setup-doctor.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

describe('Setup Doctor', () => {
  it('checks runtime, browser, two profiles, stores, credentials and snapshots without exposing secrets', async () => {
    const fixture = await healthyRoot();
    const result = await runSetupDoctor({
      repo_root: fixture.root,
      environment: fixture.environment,
      runtime: { node_version: 'v20.19.1', command_exists: () => true, browser_available: true },
    });

    expect(result).toMatchObject({ ok: true, data: { status: 'ready' } });
    expect(Object.fromEntries(result.data!.checks.map((entry) => [entry.code, entry.status]))).toMatchObject({
      NODE_20: 'passed', PNPM_AVAILABLE: 'passed', BROWSER_AVAILABLE: 'passed', TWO_1688_ACCOUNTS: 'passed',
      STORE_REGISTRY: 'passed', STORE_SELLER_CREDENTIALS: 'passed', STORE_PERFORMANCE_CREDENTIALS: 'passed',
      MARKET_SNAPSHOT: 'passed', COMMISSION_SNAPSHOT: 'passed', CATEGORY_SNAPSHOT: 'passed', OZON_MCP: 'passed',
    });
    expect(result.data!.stores[0]).toMatchObject({
      seller_credentials_configured: true,
      performance_credentials_configured: true,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('seller-secret-value');
    expect(serialized).not.toContain('performance-secret-value');
  });

  it('reports Node, pnpm, browser and 1688 profile failures deterministically', async () => {
    const fixture = await healthyRoot();
    await fs.rm(path.join(fixture.profileHome, 'profiles', 'account-b'), { recursive: true });
    const result = await runSetupDoctor({
      repo_root: fixture.root,
      environment: fixture.environment,
      runtime: { node_version: 'v18.20.0', command_exists: () => false, browser_available: false },
    });
    const checks = Object.fromEntries(result.data!.checks.map((entry) => [entry.code, entry.status]));
    expect(checks).toMatchObject({
      NODE_20: 'failed', PNPM_AVAILABLE: 'failed', BROWSER_AVAILABLE: 'failed', TWO_1688_ACCOUNTS: 'failed', OZON_MCP: 'failed',
    });
    expect(result.data?.status).toBe('blocked');
  });

  it('reports missing Seller/Performance credentials and commission snapshot independently', async () => {
    const fixture = await healthyRoot();
    await fs.rm(path.join(fixture.root, 'packages', 'steps', 'cost-pricing', 'references', 'ozon-commission-snapshot.json'));
    const result = await runSetupDoctor({
      repo_root: fixture.root,
      environment: { BB1688_HOME: fixture.profileHome },
      runtime: { node_version: 'v20.19.1', command_exists: () => true, browser_available: true },
    });
    const checks = Object.fromEntries(result.data!.checks.map((entry) => [entry.code, entry.status]));
    expect(checks).toMatchObject({
      STORE_SELLER_CREDENTIALS: 'failed',
      STORE_PERFORMANCE_CREDENTIALS: 'warning',
      COMMISSION_SNAPSHOT: 'failed',
    });
  });

  it('detects an expired category snapshot from the selected repository root', async () => {
    const fixture = await healthyRoot();
    const metadataFile = path.join(fixture.root, 'data', 'cache', 'ozon', 'category-tree', 'current.meta.json');
    const metadata = JSON.parse(await fs.readFile(metadataFile, 'utf8')) as Record<string, unknown>;
    metadata.valid_to = '2000-01-02T00:00:00.000Z';
    await fs.writeFile(metadataFile, `${JSON.stringify(metadata)}\n`, 'utf8');
    const result = await runSetupDoctor({
      repo_root: fixture.root,
      environment: fixture.environment,
      runtime: { node_version: 'v20.19.1', command_exists: () => true, browser_available: true },
    });
    expect(result.data?.checks.find((entry) => entry.code === 'CATEGORY_SNAPSHOT')).toMatchObject({
      status: 'failed',
      message: 'CATEGORY_TREE_SNAPSHOT_EXPIRED',
    });
  });
});

async function healthyRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-ozon-doctor-'));
  roots.push(root);
  const profileHome = path.join(root, '.1688');
  for (const account of ['account-a', 'account-b']) {
    const directory = path.join(profileHome, 'profiles', account);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'state.json'), JSON.stringify({ version: 1, memberId: `member-${account}` }), 'utf8');
  }
  await writeJson(path.join(root, 'data', 'config', 'ozon-stores.local.json'), [profile()]);
  await writeJson(path.join(root, 'data', 'ozon', 'category-analytics', 'raw', 'ozon-category-year-2026-06-17.json'), {
    captured_at: '2026-07-01T00:00:00.000Z', finished: true, stopped: false, level3: [{ id: 1 }],
  });
  await writeJson(path.join(root, 'packages', 'steps', 'cost-pricing', 'references', 'ozon-commission-snapshot.json'), { schema_version: 1 });
  await fs.mkdir(path.join(root, 'vendor', 'ozon-mcp'), { recursive: true });
  await fs.writeFile(path.join(root, 'vendor', 'ozon-mcp', 'pyproject.toml'), '[project]\nname="fixture"\n', 'utf8');
  await writeCategoryTree(root);
  const environment = {
    BB1688_HOME: profileHome,
    OZON_CLIENT_ID_525: '525',
    OZON_API_KEY_525: 'seller-secret-value',
    OZON_PERFORMANCE_CLIENT_ID_525: 'performance-client',
    OZON_PERFORMANCE_CLIENT_SECRET_525: 'performance-secret-value',
  };
  return { root, profileHome, environment };
}

async function writeCategoryTree(root: string) {
  const file = path.join(root, 'data', 'cache', 'ozon', 'category-tree', 'current.json');
  const text = `${JSON.stringify({ result: [{ description_category_id: 1, category_name: 'Fixture', children: [] }] })}\n`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, 'utf8');
  await writeJson(file.replace(/\.json$/u, '.meta.json'), {
    schema_version: 1,
    source: 'ozon-seller-api',
    captured_at: '2026-07-01T00:00:00.000Z',
    valid_from: '2026-07-01T00:00:00.000Z',
    valid_to: '2099-07-31T00:00:00.000Z',
    sha256: createHash('sha256').update(text).digest('hex'),
  });
}

async function writeJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function profile() {
  return {
    schema_version: 2, store_id: '525', store_name: 'Fixture', market: 'RU', currency_code: 'CNY',
    credentials: { client_id: { provider: 'env', key: 'OZON_CLIENT_ID_525' }, api_key: { provider: 'env', key: 'OZON_API_KEY_525' } },
    performance_credentials: { client_id: { provider: 'env', key: 'OZON_PERFORMANCE_CLIENT_ID_525' }, client_secret: { provider: 'env', key: 'OZON_PERFORMANCE_CLIENT_SECRET_525' } },
    publishing: { enabled: false, automation_level: 'automatic', allowed_description_category_ids: [], max_items_per_batch: 100, daily_listing_limit: 100 },
    pricing: { mode: 'multiplier', multiplier: '2', minimum_margin_percent: '0', advertising_reserve_percent: '0', return_loss_reserve_percent: '0', other_rate_percent: '10', label_fee_cny: '2', other_fixed_cny: '0' },
    polling: { timeout_ms: 60000, interval_ms: 1500, max_recoverable_retries: 2 },
  };
}
