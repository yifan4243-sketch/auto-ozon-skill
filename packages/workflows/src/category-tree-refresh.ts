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
  /** Fault-injection hook used to verify that prepared writes do not replace the active snapshot. */
  before_commit?: () => void | Promise<void>;
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
    assertCategoryTreeResult(response as unknown);
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
    await atomicPair(
      file,
      text,
      metadataFile,
      `${JSON.stringify(metadata, null, 2)}\n`,
      input.before_commit,
    );
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

async function atomicPair(
  dataFile: string,
  dataText: string,
  metadataFile: string,
  metadataText: string,
  beforeCommit?: () => void | Promise<void>,
): Promise<void> {
  const nonce = `${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  const dataTemporary = `${dataFile}.${nonce}.tmp`;
  const metadataTemporary = `${metadataFile}.${nonce}.tmp`;
  const oldData = await fs.readFile(dataFile).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error));
  const oldMetadata = await fs.readFile(metadataFile).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error));
  let dataCommitted = false;
  let metadataCommitted = false;
  try {
    await durableWrite(dataTemporary, dataText);
    await durableWrite(metadataTemporary, metadataText);
    await beforeCommit?.();
    await replaceFile(dataTemporary, dataFile);
    dataCommitted = true;
    await replaceFile(metadataTemporary, metadataFile);
    metadataCommitted = true;
  } catch (error) {
    if (dataCommitted) await restoreFile(dataFile, oldData, nonce);
    if (metadataCommitted) await restoreFile(metadataFile, oldMetadata, nonce);
    throw error;
  } finally {
    await Promise.all([
      fs.rm(dataTemporary, { force: true }),
      fs.rm(metadataTemporary, { force: true }),
    ]);
  }
}

async function durableWrite(file: string, text: string): Promise<void> {
  const handle = await fs.open(file, 'wx', 0o600);
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function replaceFile(source: string, target: string): Promise<void> {
  try {
    await fs.rename(source, target);
  } catch (error) {
    if (!['EEXIST', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    await fs.rm(target, { force: true });
    await fs.rename(source, target);
  }
}

async function restoreFile(file: string, bytes: Buffer | null, nonce: string): Promise<void> {
  if (!bytes) {
    await fs.rm(file, { force: true });
    return;
  }
  const temporary = `${file}.${nonce}.restore.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await replaceFile(temporary, file);
}

function assertCategoryTreeResult(value: unknown): asserts value is { result: unknown[] } {
  if (!isRecord(value) || !Array.isArray(value.result) || value.result.length === 0) {
    throw new Error('CATEGORY_TREE_RESPONSE_INVALID');
  }
  const pending = [...value.result];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!isRecord(node)) throw new Error('CATEGORY_TREE_RESPONSE_INVALID');
    if (node.children !== undefined && !Array.isArray(node.children)) throw new Error('CATEGORY_TREE_RESPONSE_INVALID');
    if (node.description_category_id !== undefined
      && (!Number.isSafeInteger(node.description_category_id) || typeof node.category_name !== 'string' || !node.category_name.trim())) {
      throw new Error('CATEGORY_TREE_RESPONSE_INVALID');
    }
    if (node.type_id !== undefined
      && (!Number.isSafeInteger(node.type_id) || typeof node.type_name !== 'string' || !node.type_name.trim())) {
      throw new Error('CATEGORY_TREE_RESPONSE_INVALID');
    }
    if (node.description_category_id === undefined && node.type_id === undefined && !Array.isArray(node.children)) {
      throw new Error('CATEGORY_TREE_RESPONSE_INVALID');
    }
    if (Array.isArray(node.children)) pending.push(...node.children);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
