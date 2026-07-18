import crypto, { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { CommandResult } from '@auto-ozon/contracts';
import { resolveRepoRoot } from '@auto-ozon/artifact-store';
import { EnvSecretProvider, FileStoreRegistry, resolveStoreCredentials } from '@auto-ozon/config';
import { loadOzonEnvironment, OzonSellerCategoryTreeClient, type OzonCategoryTreeTransportV1 } from '@auto-ozon/adapters-ozon';

export interface CategoryTreeRefreshResultV1 {
  schema_version: 1;
  path: string;
  captured_at: string;
  valid_to: string;
  sha256: string;
  root_count: number;
}

export async function refreshOzonCategoryTree(input: {
  store_id: string;
  transport?: OzonCategoryTreeTransportV1;
  repo_root?: string;
  signal?: AbortSignal;
}): Promise<CommandResult<CategoryTreeRefreshResultV1>> {
  try {
    const root = path.resolve(input.repo_root ?? resolveRepoRoot());
    let transport = input.transport;
    if (!transport) {
      const profile = new FileStoreRegistry(path.join(root, 'data', 'config', 'ozon-stores.local.json')).get(input.store_id);
      const credentials = resolveStoreCredentials(profile, new EnvSecretProvider(loadOzonEnvironment(process.env, root)));
      transport = new OzonSellerCategoryTreeClient(credentials);
    }
    const response = await transport.getTree(input.signal);
    const capturedAt = new Date();
    const document = { result: response.result };
    const text = `${JSON.stringify(document)}\n`;
    const sha256 = createHash('sha256').update(text).digest('hex');
    const directory = path.join(root, 'data', 'cache', 'ozon', 'category-tree');
    const file = path.join(directory, 'current.json');
    const metadataFile = path.join(directory, 'current.meta.json');
    const metadata = {
      schema_version: 1,
      source: 'ozon-seller-api',
      captured_at: capturedAt.toISOString(),
      valid_from: capturedAt.toISOString(),
      valid_to: new Date(capturedAt.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      sha256,
    } as const;
    await fs.mkdir(directory, { recursive: true });
    await atomicText(file, text);
    await atomicText(metadataFile, `${JSON.stringify(metadata, null, 2)}\n`);
    const result: CategoryTreeRefreshResultV1 = {
      schema_version: 1, path: file, captured_at: metadata.captured_at,
      valid_to: metadata.valid_to, sha256, root_count: response.result.length,
    };
    return { ok: true, command: 'workflow.category.refresh-tree', data: result, warnings: [], errors: [], nextActions: [] };
  } catch (error) {
    const detail = error && typeof error === 'object' && 'detail' in error ? (error as { detail?: unknown }).detail : undefined;
    const code = detail && typeof detail === 'object' && typeof (detail as Record<string, unknown>).code === 'string'
      ? String((detail as Record<string, unknown>).code) : error instanceof Error && /^[A-Z][A-Z0-9_]+$/u.test(error.message) ? error.message : 'CATEGORY_TREE_REFRESH_FAILED';
    return { ok: false, command: 'workflow.category.refresh-tree', warnings: [], errors: [{ code, message: 'Ozon category tree refresh failed.', detail, recoverable: true }], nextActions: [] };
  }
}

async function atomicText(file: string, text: string): Promise<void> {
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(temporary, text, { encoding: 'utf8', flag: 'wx' });
  await fs.rename(temporary, file);
}
