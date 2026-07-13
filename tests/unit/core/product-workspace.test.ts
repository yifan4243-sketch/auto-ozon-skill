import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ensureProductWorkspace,
  getProductWorkspacePaths,
  writeProductWorkspaceArtifact,
} from '../../../packages/core/src/product-workspace.js';
import {
  saveOzonDraft,
  saveOzonUploadRequest,
  saveOzonUploadResult,
} from '../../../packages/core/src/product-draft-artifacts.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe('product workspace', () => {
  it('creates the four stable stage directories under the offer ID', async () => {
    const productsDir = await tempRoot();
    const paths = await ensureProductWorkspace('123456789', productsDir);

    expect(paths.productDirectory).toBe(path.join(productsDir, '123456789'));
    await expect(
      fs.readdir(paths.productDirectory).then((entries) => entries.sort()),
    ).resolves.toEqual([
      '1688_data',
      '1688_data_v2',
      'manifest.json',
      'ozon_draft',
      'ozon_upload',
    ]);

    const manifest = JSON.parse(await fs.readFile(paths.manifest, 'utf8')) as {
      offer_id: string;
      artifact_paths: Record<string, string>;
    };
    expect(manifest.offer_id).toBe('123456789');
    expect(manifest.artifact_paths).toMatchObject({
      source_1688: '1688_data/source.json',
      canonical_v2: '1688_data_v2/product.json',
      category_attributes: 'ozon_draft/category_attributes.json',
      ozon_draft: 'ozon_draft/draft.json',
      upload_request: 'ozon_upload/request.json',
    });
  });

  it('rejects path traversal and non-numeric workspace names', () => {
    expect(() => getProductWorkspacePaths('../secret')).toThrow(
      'Invalid 1688 offer ID',
    );
    expect(() => getProductWorkspacePaths('abc')).toThrow(
      'Invalid 1688 offer ID',
    );
  });

  it('preserves completed stages while later draft and upload files are written', async () => {
    const productsDir = await tempRoot();
    const options = { offerId: '123456789', productsDir };
    await writeProductWorkspaceArtifact(
      options.offerId,
      'canonical_v2',
      { schema_version: 2 },
      {
        productsDir,
        manifest: { stages: { source_1688: 'completed', canonical_v2: 'completed' } },
      },
    );
    await saveOzonDraft(options, { draft: true });
    await saveOzonUploadRequest(options, { items: [] });
    await saveOzonUploadResult(options, { task_id: 'task-1' }, true);

    const paths = getProductWorkspacePaths(options.offerId, productsDir);
    const manifest = JSON.parse(await fs.readFile(paths.manifest, 'utf8')) as {
      stages: Record<string, string>;
    };
    expect(manifest.stages).toEqual({
      source_1688: 'completed',
      canonical_v2: 'completed',
      category_decision: 'not_started',
      category_attributes: 'not_started',
      ozon_draft: 'needs_review',
      ozon_upload: 'completed',
    });
    await expect(fs.readFile(paths.artifacts.ozon_draft, 'utf8')).resolves.toContain(
      '"draft": true',
    );
    await expect(fs.readFile(paths.artifacts.upload_request, 'utf8')).resolves.toContain(
      '"items": []',
    );
    await expect(fs.readFile(paths.artifacts.upload_result, 'utf8')).resolves.toContain(
      '"task_id": "task-1"',
    );
  });
});

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-ozon-products-'));
  roots.push(root);
  return root;
}
