import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileArtifactStore } from '../../../packages/artifact-store/src/index.js';

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

    expect(output).toBe('03-category-decision/decision.json');
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
});
