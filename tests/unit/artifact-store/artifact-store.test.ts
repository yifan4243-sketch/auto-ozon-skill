import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FileArtifactStore,
  createFileWorkflowLogger,
} from '../../../packages/artifact-store/src/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('FileArtifactStore', () => {
  it('separates numbered run evidence from reusable cache data', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-ozon-artifacts-'));
    temporaryDirectories.push(root);
    const store = new FileArtifactStore({
      repoRoot: root,
      runsRoot: path.join(root, 'runs'),
      cacheRoot: path.join(root, 'cache'),
    });

    const output = await store.write('run-1', 'category-decision', 'decision.json', {
      status: 'decided',
    });
    await store.writeCache('category-attributes', '17028741-92537', { values: [1] });

    expect(output).toBe('03-category-decision/attempt-0001/decision.json');
    expect(await store.read('run-1', 'category-decision', 'decision.json')).toEqual({
      status: 'decided',
    });
    expect(await store.readCache('category-attributes', '17028741-92537')).toEqual({
      values: [1],
    });
    expect(await fs.stat(path.join(root, 'runs', 'run-1', '03-category-decision', 'attempt-0001'))).toBeTruthy();
    expect(await fs.stat(path.join(root, 'cache', 'category-attributes'))).toBeTruthy();
  });

  it('creates and advances a recoverable workflow manifest', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-ozon-manifest-'));
    temporaryDirectories.push(root);
    const store = new FileArtifactStore({
      repoRoot: root,
      runsRoot: path.join(root, 'runs'),
      cacheRoot: path.join(root, 'cache'),
    });

    const initial = await store.ensureRun('resume-1');
    expect(initial.steps['source-1688'].status).toBe('pending');

    await store.updateStep('resume-1', 'source-1688', { status: 'running' });
    const completed = await store.updateStep('resume-1', 'source-1688', {
      status: 'succeeded',
      output: '01-source/offer-result.json',
    });

    expect(completed.current_step).toBe('source-1688');
    expect(completed.steps['source-1688']).toMatchObject({
      status: 'succeeded',
      output: '01-source/offer-result.json',
    });
    expect(completed.steps['source-1688'].started_at).not.toBeNull();
    expect(completed.steps['source-1688'].completed_at).not.toBeNull();
  });

  it('rejects traversal in run, cache, and file names', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-ozon-safe-store-'));
    temporaryDirectories.push(root);
    const store = new FileArtifactStore({ repoRoot: root });

    await expect(store.ensureRun('../escape')).rejects.toThrow('Invalid run ID');
    await expect(
      store.write('run-1', 'source-1688', '../escape.json', {}),
    ).rejects.toThrow('Invalid artifact file name');
    await expect(store.writeCache('../cache', 'key', {})).rejects.toThrow(
      'Invalid cache namespace',
    );
  });

  it('writes secret-safe workflow logs under the run directory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-ozon-logs-'));
    temporaryDirectories.push(root);
    const logger = createFileWorkflowLogger(root, 'logged-run');
    logger.info('started', { offer_id: '123', token: 'must-not-leak' });

    const text = await fs.readFile(
      path.join(root, 'logged-run', 'logs', 'workflow.log'),
      'utf8',
    );
    expect(text).toContain('started');
    expect(text).toContain('offer_id');
    expect(text).not.toContain('must-not-leak');
    expect(text).not.toContain('token');
  });

  it('rejects corrupted artifacts and keeps orphan attempts invisible', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-ozon-integrity-'));
    temporaryDirectories.push(root);
    const store = new FileArtifactStore({ runsRoot: path.join(root, 'runs') });
    await store.updateStep('integrity-1', 'source-1688', {
      status: 'running',
      input_hash: 'input-a',
      dependency_hashes: {},
      implementation_version: '2',
    });
    const output = await store.write('integrity-1', 'source-1688', 'offer-result.json', { ok: true });
    await store.updateStep('integrity-1', 'source-1688', { status: 'succeeded', output });
    await fs.mkdir(path.join(root, 'runs', 'integrity-1', '01-source', 'attempt-9999'), { recursive: true });
    await fs.writeFile(path.join(root, 'runs', 'integrity-1', '01-source', 'attempt-9999', 'offer-result.json'), '{"orphan":true}');

    expect(await store.isReusable('integrity-1', 'source-1688', {
      input_hash: 'input-a', dependency_hashes: {}, implementation_version: '2',
    })).toBe(true);
    await fs.writeFile(path.join(root, 'runs', 'integrity-1', output), '{"tampered":true}');
    expect(await store.read('integrity-1', 'source-1688', 'offer-result.json')).toBeNull();
    expect(await store.isReusable('integrity-1', 'source-1688')).toBe(false);
  });

  it('recovers historical running attempts as interrupted without deleting evidence', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-ozon-interrupted-'));
    temporaryDirectories.push(root);
    const options = { runsRoot: path.join(root, 'runs') };
    const firstProcess = new FileArtifactStore(options);
    await firstProcess.updateStep('crash-1', 'source-1688', { status: 'running' });
    const secondProcess = new FileArtifactStore(options);
    const recovered = await secondProcess.ensureRun('crash-1');
    expect(recovered.status).toBe('interrupted');
    expect(recovered.steps['source-1688']).toMatchObject({
      status: 'interrupted', error: { code: 'STEP_INTERRUPTED', recoverable: true },
    });
  });

  it('prevents concurrent writers and cascades stale status downstream', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-ozon-lock-'));
    temporaryDirectories.push(root);
    const store = new FileArtifactStore({ runsRoot: path.join(root, 'runs') });
    await store.ensureRun('locked-1');
    await store.updateStep('locked-1', 'category-decision', { status: 'running' });
    await store.updateStep('locked-1', 'category-decision', { status: 'succeeded' });
    await store.updateStep('locked-1', 'cost-pricing', { status: 'running' });
    await store.updateStep('locked-1', 'cost-pricing', { status: 'succeeded' });
    const stale = await store.markDownstreamStale('locked-1', 'category-decision');
    expect(stale.steps['cost-pricing'].status).toBe('stale');

    await store.withRunLock('locked-1', async () => {
      await expect(store.withRunLock('locked-1', async () => undefined)).rejects.toMatchObject({ code: 'RUN_LOCKED' });
    });
  });
});
