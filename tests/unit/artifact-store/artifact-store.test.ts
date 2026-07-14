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

    expect(output).toBe('03-category-decision/attempts/0001/decision.json');
    expect(await store.read('run-1', 'category-decision', 'decision.json')).toEqual({
      status: 'decided',
    });
    expect(await store.readCache('category-attributes', '17028741-92537')).toEqual({
      values: [1],
    });
    expect(await fs.stat(path.join(root, 'runs', 'run-1', '03-category-decision'))).toBeTruthy();
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
    const output = await store.write('resume-1', 'source-1688', 'offer-result.json', { ok: true });
    const completed = await store.updateStep('resume-1', 'source-1688', {
      status: 'succeeded',
      output,
    });

    expect(completed.current_step).toBe('source-1688');
    expect(completed.steps['source-1688']).toMatchObject({
      status: 'succeeded',
      output: '01-source/attempts/0001/offer-result.json',
      artifact: { schema_version: 1 },
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

  it('rejects V1 manifests instead of silently migrating old runs', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-ozon-legacy-'));
    temporaryDirectories.push(root);
    const runsRoot = path.join(root, 'runs');
    await fs.mkdir(path.join(runsRoot, 'legacy-run'), { recursive: true });
    await fs.writeFile(path.join(runsRoot, 'legacy-run', 'manifest.json'), '{"schema_version":1,"run_id":"legacy-run"}\n');
    const store = new FileArtifactStore({ runsRoot, cacheRoot: path.join(root, 'cache') });
    await expect(store.ensureRun('legacy-run')).rejects.toMatchObject({ code: 'LEGACY_RUN_UNSUPPORTED' });
  });

  it('detects corrupt artifacts, cascades stale state, and rejects concurrent run locks', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-ozon-recovery-'));
    temporaryDirectories.push(root);
    const store = new FileArtifactStore({ runsRoot: path.join(root, 'runs'), cacheRoot: path.join(root, 'cache') });
    await store.ensureRun('recovery-run');
    const output = await store.write('recovery-run', 'source-1688', 'offer-result.json', { schema_version: 1, ok: true });
    await store.updateStep('recovery-run', 'source-1688', { status: 'succeeded', output });
    await fs.writeFile(path.join(root, 'runs', 'recovery-run', output), '{broken');
    await expect(store.read('recovery-run', 'source-1688', 'offer-result.json')).resolves.toBeNull();
    const stale = await store.markStaleFrom('recovery-run', 'category-attributes');
    expect(stale.steps['category-attributes'].status).toBe('stale');
    expect(stale.steps['ozon-publish'].status).toBe('stale');
    await store.withRunLock('recovery-run', async () => {
      await expect(store.withRunLock('recovery-run', async () => undefined)).rejects.toMatchObject({ code: 'RUN_LOCKED' });
    });
  });
});
