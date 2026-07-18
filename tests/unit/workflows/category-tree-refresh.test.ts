import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { refreshOzonCategoryTree } from '../../../packages/workflows/src/category-tree-refresh.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

describe('Category Tree Refresh', () => {
  it('writes a valid snapshot and metadata with the exact file hash and 30-day validity', async () => {
    const root = await newRoot();
    const before = Date.now();
    const result = await refreshOzonCategoryTree({ store_id: '525', repo_root: root, transport: transport(tree('One', 1)) });
    const after = Date.now();
    expect(result).toMatchObject({ ok: true, data: { root_count: 1 } });
    const file = snapshotFile(root);
    const bytes = await fs.readFile(file);
    const metadata = JSON.parse(await fs.readFile(file.replace(/\.json$/u, '.meta.json'), 'utf8')) as Record<string, string>;
    expect(metadata.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(result.data?.sha256).toBe(metadata.sha256);
    expect(Date.parse(metadata.captured_at!)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(metadata.captured_at!)).toBeLessThanOrEqual(after);
    expect(Date.parse(metadata.valid_to!) - Date.parse(metadata.valid_from!)).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('returns a structured failure and writes nothing when the API fails', async () => {
    const root = await newRoot();
    const result = await refreshOzonCategoryTree({
      store_id: '525', repo_root: root,
      transport: { getTree: async () => { throw new Error('offline'); } },
    });
    expect(result).toMatchObject({ ok: false, errors: [{ code: 'CATEGORY_TREE_REFRESH_FAILED', recoverable: true }] });
    await expect(fs.stat(snapshotFile(root))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects malformed Seller API data before replacing the current snapshot', async () => {
    const root = await newRoot();
    const result = await refreshOzonCategoryTree({
      store_id: '525', repo_root: root,
      transport: { getTree: async () => ({ result: [{ description_category_id: 'bad', category_name: 'Broken' }] }) as never },
    });
    expect(result).toMatchObject({ ok: false, errors: [{ code: 'CATEGORY_TREE_RESPONSE_INVALID' }] });
    await expect(fs.stat(snapshotFile(root))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the previous data and metadata intact when interrupted before commit', async () => {
    const root = await newRoot();
    const file = snapshotFile(root);
    const metadataFile = file.replace(/\.json$/u, '.meta.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'old-data\n', 'utf8');
    await fs.writeFile(metadataFile, 'old-metadata\n', 'utf8');

    const result = await refreshOzonCategoryTree({
      store_id: '525', repo_root: root, transport: transport(tree('New', 2)),
      before_commit: () => { throw new Error('simulated interruption'); },
    });
    expect(result.ok).toBe(false);
    await expect(fs.readFile(file, 'utf8')).resolves.toBe('old-data\n');
    await expect(fs.readFile(metadataFile, 'utf8')).resolves.toBe('old-metadata\n');
    await expect(fs.readdir(path.dirname(file))).resolves.toEqual(['current.json', 'current.meta.json']);
  });

  it('replaces an existing snapshot on the host platform, including Windows', async () => {
    const root = await newRoot();
    expect((await refreshOzonCategoryTree({ store_id: '525', repo_root: root, transport: transport(tree('First', 1)) })).ok).toBe(true);
    expect((await refreshOzonCategoryTree({ store_id: '525', repo_root: root, transport: transport(tree('Second', 2)) })).ok).toBe(true);
    const current = JSON.parse(await fs.readFile(snapshotFile(root), 'utf8')) as { result: Array<{ category_name: string }> };
    expect(current.result[0]?.category_name).toBe('Second');
    const bytes = await fs.readFile(snapshotFile(root));
    const metadata = JSON.parse(await fs.readFile(snapshotFile(root).replace(/\.json$/u, '.meta.json'), 'utf8')) as { sha256: string };
    expect(metadata.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  });
});

async function newRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-ozon-category-refresh-'));
  roots.push(root);
  return root;
}

function snapshotFile(root: string): string {
  return path.join(root, 'data', 'cache', 'ozon', 'category-tree', 'current.json');
}

function tree(name: string, id: number) {
  return [{ description_category_id: id, category_name: name, children: [{ type_id: id * 10, type_name: `${name} Type`, children: [] }] }];
}

function transport(result: ReturnType<typeof tree>) {
  return { getTree: async () => ({ result }) };
}
