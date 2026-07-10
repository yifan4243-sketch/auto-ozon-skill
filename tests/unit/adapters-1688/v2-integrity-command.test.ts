import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OfferResult } from '../../../packages/adapters-1688/src/engine/commands/offers.js';

const dispatchMock = vi.hoisted(() => vi.fn());
const integrityMock = vi.hoisted(() => vi.fn());

vi.mock('../../../packages/adapters-1688/src/engine/session/dispatch.js', () => ({
  dispatch: dispatchMock,
}));
vi.mock('../../../packages/transformer/src/canonical-v2-integrity.js', () => ({
  checkCanonicalV2Integrity: integrityMock,
}));

import { buildProgram } from '../../../apps/cli/src/cli.js';
import { get1688OffersV2 } from '../../../packages/adapters-1688/src/client.js';

const roots: string[] = [];

beforeEach(() => {
  process.exitCode = undefined;
  const offer = readFixture<OfferResult>('offer-result.json');
  dispatchMock.mockReset();
  dispatchMock.mockResolvedValue(offer);
  integrityMock.mockReset();
  integrityMock.mockReturnValue({
    status: 'fail',
    checked_product_count: 1,
    violations: [
      {
        code: 'TEST_INTEGRITY_VIOLATION',
        offer_id: offer.offerId,
        source_sku_id: null,
        message: 'Injected test violation.',
      },
    ],
    product_results: [
      {
        offer_id: offer.offerId,
        source_sku_count: offer.skus.length,
        expected_canonical_sku_count: offer.skus.length,
        canonical_sku_count: offer.skus.length,
        passed: false,
        violation_codes: ['TEST_INTEGRITY_VIOLATION'],
      },
    ],
  });
});

afterEach(async () => {
  process.exitCode = undefined;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('V2 integrity command failure semantics', () => {
  it('returns V2_INTEGRITY_FAILED and still saves diagnostic artifacts', async () => {
    const saveDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-ozon-integrity-'));
    roots.push(saveDir);

    const result = await get1688OffersV2({
      offerIds: ['123456789'],
      saveDir,
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toMatchObject([{ code: 'V2_INTEGRITY_FAILED' }]);
    expect(result.data?.integrity_report.status).toBe('fail');
    await expect(
      fs.stat(result.data!.artifacts!.artifact_paths.integrity_report),
    ).resolves.toBeTruthy();
  });

  it('sets a non-zero CLI exit code for integrity failure', async () => {
    let stdout = '';
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk) => {
        stdout += String(chunk);
        return true;
      });
    try {
      await buildProgram().parseAsync([
        'node',
        'auto-ozon',
        'source',
        'offers',
        '123456789',
        '--schema-version',
        '2',
        '--json',
      ]);
    } finally {
      write.mockRestore();
    }

    const result = JSON.parse(stdout) as { errors: Array<{ code: string }> };
    expect(result.errors[0]!.code).toBe('V2_INTEGRITY_FAILED');
    expect(process.exitCode).toBe(1);
  });
});

function readFixture<T>(name: string): T {
  return JSON.parse(
    fsSync.readFileSync(
      new URL(`../../fixtures/1688/${name}`, import.meta.url),
      'utf8',
    ),
  ) as T;
}
