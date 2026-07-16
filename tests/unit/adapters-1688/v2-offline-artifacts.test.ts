import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { buildProgram } from '../../../apps/cli/src/cli.js';
import type { OfferBatchResult, OfferResult } from '../../../packages/adapters-1688/src/engine/commands/offers.js';
import { normalizeV2Offline } from '../../helpers/source-api.js';

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

  it('writes the standard offer workspace and drops secret-like unknown fields', async () => {
    const root = await tempRoot();
    const input = path.join(root, 'offer-with-extra.json');
    const productsDir = path.join(root, 'products');
    const offer = readFixture<OfferResult>('offer-result.json') as OfferResult & {
      token?: string;
      cookie?: string;
      unknown?: unknown;
    };
    offer.token = 'must-not-be-saved';
    offer.cookie = 'also-secret';
    offer.unknown = { password: 'hidden' };
    await writeJson(input, offer);

    const result = await normalizeV2Offline({ inputPath: input, productsDir });
    const artifacts = result.data?.artifacts;
    const productArtifacts = artifacts?.products[0];

    expect(result.ok).toBe(true);
    expect(artifacts).not.toBeNull();
    expect(productArtifacts?.product_directory).toBe(
      path.join(productsDir, offer.offerId),
    );
    await expect(fs.stat(productArtifacts!.artifact_paths.manifest)).resolves.toBeTruthy();
    await expect(fs.stat(productArtifacts!.artifact_paths.source_1688)).resolves.toBeTruthy();
    await expect(fs.stat(productArtifacts!.artifact_paths.canonical_v2)).resolves.toBeTruthy();
    await expect(fs.stat(productArtifacts!.artifact_paths.integrity_report)).resolves.toBeTruthy();

    const raw = await fs.readFile(
      productArtifacts!.artifact_paths.source_1688,
      'utf8',
    );
    expect(raw).not.toContain('must-not-be-saved');
    expect(raw).not.toContain('also-secret');
    expect(raw).not.toContain('password');

    const manifest = JSON.parse(
      await fs.readFile(productArtifacts!.artifact_paths.manifest, 'utf8'),
    ) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      schema_version: 1,
      offer_id: offer.offerId,
      collection: {
        command: 'source.normalize-v2',
        method: 'offers',
      },
      stages: {
        source_1688: 'completed',
        canonical_v2: 'needs_review',
        category_decision: 'not_started',
        category_attributes: 'not_started',
      },
    });
    expect(JSON.stringify(manifest)).not.toContain(input);
  });

  it('reuses the offer workspace instead of creating duplicate run directories', async () => {
    const root = await tempRoot();
    const input = path.join(root, 'offer.json');
    const productsDir = path.join(root, 'products');
    await writeJson(input, readFixture<OfferResult>('offer-result.json'));

    const first = await normalizeV2Offline({ inputPath: input, productsDir });
    const second = await normalizeV2Offline({ inputPath: input, productsDir });

    expect(first.data?.artifacts?.products[0]?.product_directory).toBe(
      second.data?.artifacts?.products[0]?.product_directory,
    );
    await expect(
      fs.stat(first.data!.artifacts!.products[0]!.product_directory),
    ).resolves.toBeTruthy();
    await expect(
      fs
        .readdir(first.data!.artifacts!.products[0]!.product_directory)
        .then((entries) => entries.sort()),
    ).resolves.toEqual([
      '1688_data',
      '1688_data_v2',
      'manifest.json',
      'ozon_category',
    ]);
  });

  it('writes each product in a batch to its own offer ID workspace', async () => {
    const root = await tempRoot();
    const input = path.join(root, 'batch.json');
    const productsDir = path.join(root, 'products');
    const first = readFixture<OfferResult>('offer-result.json');
    const second = { ...structuredClone(first), offerId: '123456790' };
    const batch: OfferBatchResult = {
      mode: 'offers',
      total: 2,
      success: 2,
      failed: 0,
      offerIds: [first.offerId, second.offerId],
      offers: [first, second],
      failures: [],
    };
    await writeJson(input, batch);

    const result = await normalizeV2Offline({ inputPath: input, productsDir });

    expect(result.ok).toBe(true);
    expect(result.data?.artifacts?.products.map((item) => item.offer_id)).toEqual([
      '123456789',
      '123456790',
    ]);
    await expect(fs.stat(path.join(productsDir, '123456789'))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(productsDir, '123456790'))).resolves.toBeTruthy();
  });

  it('replaces a prior source failure when the same offer later succeeds', async () => {
    const root = await tempRoot();
    const productsDir = path.join(root, 'products');
    const failedInput = path.join(root, 'failed.json');
    const successfulInput = path.join(root, 'offer.json');
    const offer = readFixture<OfferResult>('offer-result.json');
    const failedBatch: OfferBatchResult = {
      mode: 'offers',
      total: 1,
      success: 0,
      failed: 1,
      offerIds: [offer.offerId],
      offers: [],
      failures: [
        {
          offerId: offer.offerId,
          code: 'DEEP_COLLECT_FAILED',
          message: 'temporary failure',
        },
      ],
    };
    await writeJson(failedInput, failedBatch);
    await writeJson(successfulInput, offer);

    const failed = await normalizeV2Offline({ inputPath: failedInput, productsDir });
    const failurePath = failed.data!.artifacts!.failures[0]!.source_failure;
    await expect(fs.stat(failurePath)).resolves.toBeTruthy();

    const succeeded = await normalizeV2Offline({ inputPath: successfulInput, productsDir });
    expect(succeeded.ok).toBe(true);
    await expect(fs.stat(failurePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports ARTIFACT_WRITE_FAILED instead of pretending save success', async () => {
    const root = await tempRoot();
    const input = path.join(root, 'offer.json');
    const productsDir = path.join(root, 'not-a-directory');
    await writeJson(input, readFixture<OfferResult>('offer-result.json'));
    await fs.writeFile(productsDir, 'file', 'utf8');

    const result = await normalizeV2Offline({ inputPath: input, productsDir });

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
