import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadOzonEnvironment } from '../../../packages/adapters-ozon/src/local-env.js';

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
      'OZON_CLIENT_ID=local-id\nOZON_API_KEY="local-key"\nUNRELATED=value\n',
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
  });
});
