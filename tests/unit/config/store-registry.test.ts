import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EnvSecretProvider, FileStoreRegistry, resolvePerformanceCredentials, resolveStoreCredentials } from '../../../packages/config/src/index.js';

const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true, force: true })));

describe('StoreRegistryV2', () => {
  it('loads one strict profile and resolves only its explicit secret references', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-ozon-store-'));
    temporary.push(directory);
    const file = path.join(directory, 'stores.json');
    fs.writeFileSync(file, JSON.stringify([profile()]));
    const store = new FileStoreRegistry(file).get('525');
    const credentials = resolveStoreCredentials(store, new EnvSecretProvider({
      OZON_CLIENT_ID_525: '525', OZON_API_KEY_525: 'key-525',
      OZON_API_KEY_999: 'must-not-be-read',
    }));
    expect(credentials).toEqual({ clientId: '525', apiKey: 'key-525' });
  });

  it('rejects unknown fields, unsafe IDs, credential mismatch, and incomplete pricing', () => {
    expect(() => writeAndRead({ ...profile(), extra: true })).toThrow(/Unknown store profile fields/u);
    expect(() => writeAndRead({ ...profile(), store_id: '../escape' })).toThrow(/STORE_ID_INVALID/u);
    expect(() => resolveStoreCredentials(profile(), new EnvSecretProvider({ OZON_CLIENT_ID_525: '999', OZON_API_KEY_525: 'key' }))).toThrow(/STORE_ID_CREDENTIAL_MISMATCH/u);
    expect(() => writeAndRead({ ...profile(), pricing: { ...profile().pricing, multiplier: undefined } })).toThrow(/requires a positive multiplier/u);
  });

  it('keeps optional Performance credentials separate from Seller credentials', () => {
    const configured = writeAndRead({
      ...profile(),
      performance_credentials: {
        client_id: { provider: 'env', key: 'OZON_PERFORMANCE_CLIENT_ID_525' },
        client_secret: { provider: 'env', key: 'OZON_PERFORMANCE_CLIENT_SECRET_525' },
      },
    });
    const provider = new EnvSecretProvider({
      OZON_CLIENT_ID_525: '525', OZON_API_KEY_525: 'seller-key',
      OZON_PERFORMANCE_CLIENT_ID_525: 'performance-id',
      OZON_PERFORMANCE_CLIENT_SECRET_525: 'performance-secret',
    });
    expect(resolveStoreCredentials(configured, provider)).toEqual({ clientId: '525', apiKey: 'seller-key' });
    expect(resolvePerformanceCredentials(configured, provider)).toEqual({ clientId: 'performance-id', clientSecret: 'performance-secret' });
    expect(() => resolvePerformanceCredentials(profile(), provider)).toThrow('PERFORMANCE_CREDENTIALS_NOT_CONFIGURED');
  });

  it('updates publishing through a locked atomic replacement and never removes another writer lock', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-ozon-store-update-'));
    temporary.push(directory);
    const file = path.join(directory, 'stores.json');
    fs.writeFileSync(file, JSON.stringify([{ ...profile(), publishing: { ...profile().publishing, enabled: false } }]));
    const registry = new FileStoreRegistry(file);
    expect(registry.updatePublishingEnabled('525', true).publishing.enabled).toBe(true);
    expect(registry.get('525').publishing.enabled).toBe(true);

    fs.writeFileSync(`${file}.lock`, 'other-writer');
    expect(() => registry.updatePublishingEnabled('525', false)).toThrow('STORE_PROFILE_LOCKED');
    expect(fs.readFileSync(`${file}.lock`, 'utf8')).toBe('other-writer');
    expect(registry.get('525').publishing.enabled).toBe(true);
  });
});

function writeAndRead(value: unknown) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-ozon-store-'));
  temporary.push(directory);
  const file = path.join(directory, 'stores.json');
  fs.writeFileSync(file, JSON.stringify([value]));
  return new FileStoreRegistry(file).get(String((value as { store_id?: string }).store_id));
}

function profile() {
  return {
    schema_version: 2 as const, store_id: '525', store_name: '店铺', market: 'RU' as const, currency_code: 'CNY' as const,
    credentials: { client_id: { provider: 'env' as const, key: 'OZON_CLIENT_ID_525' }, api_key: { provider: 'env' as const, key: 'OZON_API_KEY_525' } },
    publishing: { enabled: true, automation_level: 'automatic' as const, allowed_description_category_ids: [], max_items_per_batch: 100, daily_listing_limit: 100 },
    pricing: { mode: 'multiplier' as const, multiplier: '2', minimum_margin_percent: '0', advertising_reserve_percent: '0', return_loss_reserve_percent: '0', other_rate_percent: '10', label_fee_cny: '2', other_fixed_cny: '0' },
    polling: { timeout_ms: 60000, interval_ms: 1500, max_recoverable_retries: 2 as const },
  };
}
