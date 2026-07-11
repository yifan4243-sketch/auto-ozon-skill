import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { buildProgram } from '../../../apps/cli/src/cli.js';
import type { OfferBatchResult, OfferResult } from '../../../packages/adapters-1688/src/engine/commands/offers.js';
import { normalizeV2Offline } from '../../../packages/adapters-1688/src/v2/offline-normalize.js';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true }),
    ),
  );
});

describe('offline CanonicalProductV2 replay and artifacts', () => {
  it('normalizes one OfferResult with explicit discovery context', async () => {
    const root = await tempRoot();
    const input = path.join(root, 'offer.json');
    await writeJson(input, readFixture<OfferResult>('offer-result.json'));

    const result = await normalizeV2Offline({
      inputPath: input,
      method: 'keyword',
      searchTerm: '修枝剪',
    });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      schema_version: 2,
      mode: 'keyword',
      query: '修枝剪',
      total: 1,
      success: 1,
      failed: 0,
      integrity_report: { status: 'pass' },
    });
    expect(result.data?.items[0]!.source.discovery_context).toEqual({
      search_term: '修枝剪',
      seed_offer_id: null,
    });
  });

  it('exposes source normalize-v2 as an offline CLI command', async () => {
    const root = await tempRoot();
    const input = path.join(root, 'offer.json');
    await writeJson(input, readFixture<OfferResult>('offer-result.json'));
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
        'normalize-v2',
        '--input',
        input,
        '--method',
        'similar',
        '--seed-offer-id',
        '999999999',
        '--json',
      ]);
    } finally {
      write.mockRestore();
    }

    const result = JSON.parse(stdout) as {
      data: { schema_version: number; items: Array<{ source: { discovery_context: unknown } }> };
    };
    expect(result.data.schema_version).toBe(2);
    expect(result.data.items[0]!.source.discovery_context).toEqual({
      search_term: null,
      seed_offer_id: '999999999',
    });
  });

  it('normalizes an OfferBatchResult and preserves collection failures', async () => {
    const root = await tempRoot();
    const input = path.join(root, 'batch.json');
    const offer = readFixture<OfferResult>('offer-result.json');
    const batch: OfferBatchResult = {
      mode: 'offers',
      total: 2,
      success: 1,
      failed: 1,
      offerIds: [offer.offerId, 'bad-id'],
      offers: [offer],
      failures: [{ offerId: 'bad-id', code: 'BAD_INPUT', message: 'Invalid offerId' }],
    };
    await writeJson(input, batch);

    const result = await normalizeV2Offline({ inputPath: input });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ total: 2, success: 1, failed: 1 });
    expect(result.data?.items).toHaveLength(1);
    expect(result.data?.failures).toEqual([
      {
        offer_id: 'bad-id',
        code: 'BAD_INPUT',
        message: 'Invalid offerId',
        recoverable: false,
      },
    ]);
  });

  it('rejects unknown nested and incomplete input shapes with BAD_INPUT', async () => {
    const root = await tempRoot();
    const input = path.join(root, 'invalid.json');
    await writeJson(input, { data: { offers: [] } });

    const result = await normalizeV2Offline({ inputPath: input });

    expect(result).toMatchObject({
      ok: false,
      errors: [{ code: 'BAD_INPUT', recoverable: false }],
    });
    expect(result.errors[0]!.message).toContain('OfferResult or an OfferBatchResult');
  });

  it('writes the standard run directory and drops secret-like unknown fields', async () => {
    const root = await tempRoot();
    const input = path.join(root, 'offer-with-extra.json');
    const saveDir = path.join(root, 'runs');
    const offer = readFixture<OfferResult>('offer-result.json') as OfferResult & {
      token?: string;
      cookie?: string;
      unknown?: unknown;
    };
    offer.token = 'must-not-be-saved';
    offer.cookie = 'also-secret';
    offer.unknown = { password: 'hidden' };
    await writeJson(input, offer);

    const result = await normalizeV2Offline({ inputPath: input, saveDir });
    const artifacts = result.data?.artifacts;

    expect(result.ok).toBe(true);
    expect(artifacts).not.toBeNull();
    await expect(fs.stat(artifacts!.artifact_paths.manifest)).resolves.toBeTruthy();
    await expect(fs.stat(artifacts!.artifact_paths.raw_directory)).resolves.toBeTruthy();
    await expect(
      fs.stat(artifacts!.artifact_paths.canonical_v2_directory),
    ).resolves.toBeTruthy();
    await expect(fs.stat(artifacts!.artifact_paths.integrity_report)).resolves.toBeTruthy();
    await expect(fs.stat(artifacts!.artifact_paths.failures)).resolves.toBeTruthy();

    const raw = await fs.readFile(
      path.join(artifacts!.artifact_paths.raw_directory, `${offer.offerId}.json`),
      'utf8',
    );
    expect(raw).not.toContain('must-not-be-saved');
    expect(raw).not.toContain('also-secret');
    expect(raw).not.toContain('password');

    const manifest = JSON.parse(
      await fs.readFile(artifacts!.artifact_paths.manifest, 'utf8'),
    ) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      command: 'source.normalize-v2',
      schema_version: 2,
      collection_method: 'offers',
      total: 1,
      success: 1,
      failed: 0,
    });
    expect(JSON.stringify(manifest)).not.toContain(input);
  });

  it('creates collision-free run directories without overwriting', async () => {
    const root = await tempRoot();
    const input = path.join(root, 'offer.json');
    const saveDir = path.join(root, 'runs');
    await writeJson(input, readFixture<OfferResult>('offer-result.json'));

    const first = await normalizeV2Offline({ inputPath: input, saveDir });
    const second = await normalizeV2Offline({ inputPath: input, saveDir });

    expect(first.data?.artifacts?.run_directory).not.toBe(
      second.data?.artifacts?.run_directory,
    );
    await expect(
      fs.stat(first.data!.artifacts!.run_directory),
    ).resolves.toBeTruthy();
    await expect(
      fs.stat(second.data!.artifacts!.run_directory),
    ).resolves.toBeTruthy();
  });

  it('writes the complete offline command result to --output', async () => {
    const root = await tempRoot();
    const input = path.join(root, 'offer.json');
    const output = path.join(root, 'out', 'result.json');
    await writeJson(input, readFixture<OfferResult>('offer-result.json'));

    const result = await normalizeV2Offline({ inputPath: input, outputPath: output });
    const written = JSON.parse(await fs.readFile(output, 'utf8')) as {
      ok: boolean;
      data: { schema_version: number };
    };

    expect(result.ok).toBe(true);
    expect(written.ok).toBe(true);
    expect(written.data.schema_version).toBe(2);
  });

  it('reports ARTIFACT_WRITE_FAILED instead of pretending save success', async () => {
    const root = await tempRoot();
    const input = path.join(root, 'offer.json');
    const saveDir = path.join(root, 'not-a-directory');
    await writeJson(input, readFixture<OfferResult>('offer-result.json'));
    await fs.writeFile(saveDir, 'file', 'utf8');

    const result = await normalizeV2Offline({ inputPath: input, saveDir });

    expect(result.ok).toBe(false);
    expect(result.data?.items).toHaveLength(1);
    expect(result.errors).toMatchObject([{ code: 'ARTIFACT_WRITE_FAILED' }]);
    expect(result.data?.artifacts).toBeNull();
  });
});

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-ozon-v2-'));
  tempRoots.push(root);
  return root;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readFixture<T>(name: string): T {
  return JSON.parse(
    fsSync.readFileSync(
      new URL(`../../fixtures/1688/${name}`, import.meta.url),
      'utf8',
    ),
  ) as T;
}
