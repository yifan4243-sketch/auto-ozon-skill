import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FileArtifactStore,
  silentWorkflowLogger,
} from '../../../../packages/artifact-store/src/index.js';

import { runSource1688 } from '../../../../packages/steps/source-1688/src/index.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    fs.rm(root, { recursive: true, force: true }),
  ));
});

describe('runSource1688', () => {
  it('sanitizes collection output and writes the numbered source artifact', async () => {
    const { store, context } = await testContext('source-success');

    const result = await runSource1688({ mode: 'offers', offerIds: [] }, context);

    expect(result).toMatchObject({ ok: true, command: 'source.offers' });
    await expect(store.read('source-success', 'source-1688', 'offer-result.json'))
      .resolves.toMatchObject({ mode: 'offers', details: { total: 0 } });
    await expect(store.readManifest('source-success')).resolves.toMatchObject({
      steps: { 'source-1688': { status: 'succeeded', output: '01-source/offer-result.json' } },
    });
  });

  it('propagates invalid offer input as a non-recoverable failed step', async () => {
    const { store, context } = await testContext('source-failed');

    const result = await runSource1688({ mode: 'offers', offerIds: ['bad-offer'] }, context);
    expect(result).toMatchObject({
      ok: false,
      errors: [{ code: 'SOURCE_COLLECTION_FAILED', recoverable: false }],
    });
    await expect(store.readManifest('source-failed')).resolves.toMatchObject({
      steps: { 'source-1688': { status: 'failed', error_code: 'SOURCE_COLLECTION_FAILED' } },
    });
  });
});

async function testContext(runId: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-ozon-source-step-'));
  roots.push(root);
  const store = new FileArtifactStore({
    runsRoot: path.join(root, 'runs'),
    cacheRoot: path.join(root, 'cache'),
  });
  return {
    store,
    context: {
      run_id: runId,
      artifact_store: store,
      logger: silentWorkflowLogger,
      force_refresh: false,
    },
  };
}
