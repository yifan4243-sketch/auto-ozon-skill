import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildOzonMcpChildEnvironment,
  buildSafeChildEnvironment,
  loadOzonEnvironment,
  withOzonMcpCredentials,
} from '../../../packages/adapters-ozon/src/local-env.js';
import { sanitizeSecretText } from '../../../packages/adapters-ozon/src/config.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('local Ozon environment', () => {
  it('loads ignored repository credentials without overriding explicit environment values', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-ozon-env-'));
    roots.push(root);
    fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages: []\n');
    fs.writeFileSync(
      path.join(root, '.env'),
      'OZON_CLIENT_ID=local-id\nOZON_API_KEY="local-key"\nOZON_CLIENT_ID_525=store-id\nOZON_API_KEY_525=store-key\nUNRELATED=value\n',
    );

    expect(loadOzonEnvironment({}, root)).toMatchObject({
      OZON_CLIENT_ID: 'local-id',
      OZON_API_KEY: 'local-key',
    });
    expect(loadOzonEnvironment({ OZON_CLIENT_ID: 'explicit-id' }, root)).toMatchObject({
      OZON_CLIENT_ID: 'explicit-id',
      OZON_API_KEY: 'local-key',
    });
    expect(loadOzonEnvironment({}, root)).not.toHaveProperty('UNRELATED');
    expect(loadOzonEnvironment({}, root)).toMatchObject({
      OZON_CLIENT_ID_525: 'store-id',
      OZON_API_KEY_525: 'store-key',
    });
  });

  it('does not forward unrelated secrets or other-store credentials to Ozon MCP', () => {
    const environment = {
      PATH: 'safe-path',
      SYSTEMROOT: 'C:\\Windows',
      OZON_CLIENT_ID: 'default-store',
      OZON_API_KEY: 'default-key',
      OZON_CLIENT_ID_525: 'other-store',
      OZON_API_KEY_525: 'other-key',
      GITHUB_TOKEN: 'must-not-leak',
      IMAGE_GENERATION_API_KEY: 'must-not-leak-either',
    };
    const credentials = loadOzonEnvironment(environment, 'Z:\\missing-workspace');
    const child = buildOzonMcpChildEnvironment(credentials, environment, 'seller');

    expect(child).toMatchObject({
      PATH: 'safe-path',
      SYSTEMROOT: 'C:\\Windows',
      OZON_CLIENT_ID: 'default-store',
      OZON_API_KEY: 'default-key',
    });
    expect(child).not.toHaveProperty('OZON_CLIENT_ID_525');
    expect(child).not.toHaveProperty('OZON_API_KEY_525');
    expect(child).not.toHaveProperty('GITHUB_TOKEN');
    expect(child).not.toHaveProperty('IMAGE_GENERATION_API_KEY');
    expect(buildSafeChildEnvironment(environment)).not.toHaveProperty('OZON_API_KEY');
  });

  it('forwards only the credential family requested by the current operation', () => {
    const credentials = {
      OZON_CLIENT_ID: 'seller-id', OZON_API_KEY: 'seller-key',
      OZON_PERFORMANCE_CLIENT_ID: 'performance-id', OZON_PERFORMANCE_CLIENT_SECRET: 'performance-secret',
    };
    const system = { PATH: 'safe', GITHUB_TOKEN: 'never-forward' };
    expect(buildOzonMcpChildEnvironment(credentials, system, 'seller')).toEqual({
      PATH: 'safe', OZON_CLIENT_ID: 'seller-id', OZON_API_KEY: 'seller-key',
    });
    expect(buildOzonMcpChildEnvironment(credentials, system, 'performance')).toEqual({
      PATH: 'safe', OZON_PERFORMANCE_CLIENT_ID: 'performance-id', OZON_PERFORMANCE_CLIENT_SECRET: 'performance-secret',
    });
    expect(buildOzonMcpChildEnvironment(credentials, system, 'both')).toMatchObject(credentials);
    expect(buildOzonMcpChildEnvironment(credentials, system, 'none')).toEqual({ PATH: 'safe' });
  });

  it('keeps concurrent Seller and Performance scopes isolated', async () => {
    const barrier = deferred<void>();
    const seller = withOzonMcpCredentials({
      OZON_CLIENT_ID: 'seller-a', OZON_API_KEY: 'key-a',
      OZON_PERFORMANCE_CLIENT_ID: 'must-not-leak-a', OZON_PERFORMANCE_CLIENT_SECRET: 'must-not-leak-a-secret',
    }, async () => {
      await barrier.promise;
      return buildOzonMcpChildEnvironment(undefined, { PATH: 'safe' });
    }, 'seller');
    const performance = withOzonMcpCredentials({
      OZON_CLIENT_ID: 'must-not-leak-b', OZON_API_KEY: 'must-not-leak-b-key',
      OZON_PERFORMANCE_CLIENT_ID: 'performance-b', OZON_PERFORMANCE_CLIENT_SECRET: 'secret-b',
    }, async () => {
      barrier.resolve(undefined);
      await Promise.resolve();
      return buildOzonMcpChildEnvironment(undefined, { PATH: 'safe' });
    }, 'performance');
    await expect(Promise.all([seller, performance])).resolves.toEqual([
      { PATH: 'safe', OZON_CLIENT_ID: 'seller-a', OZON_API_KEY: 'key-a' },
      { PATH: 'safe', OZON_PERFORMANCE_CLIENT_ID: 'performance-b', OZON_PERFORMANCE_CLIENT_SECRET: 'secret-b' },
    ]);
  });

  it('redacts dynamically named store credentials', () => {
    const previous = process.env.OZON_API_KEY_STORE_525;
    process.env.OZON_API_KEY_STORE_525 = 'dynamic-store-secret';
    try {
      expect(sanitizeSecretText('failed with dynamic-store-secret')).toBe(
        'failed with [OZON_API_KEY_STORE_525_REDACTED]',
      );
    } finally {
      if (previous === undefined) delete process.env.OZON_API_KEY_STORE_525;
      else process.env.OZON_API_KEY_STORE_525 = previous;
    }
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
