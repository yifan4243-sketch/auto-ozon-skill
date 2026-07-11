import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import type { CategoryAttributesV1 } from '../../../contracts/src/category-attributes.js';

function resolveRepoRoot(): string {
  let current = process.cwd();
  while (true) {
    if (fsSync.existsSync(path.join(current, 'pnpm-workspace.yaml'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return process.cwd();
    current = parent;
  }
}

const CACHE_RELATIVE_DIR = 'data/cache/ozon/category-attributes';

function resolveCacheDir(): string {
  return path.join(resolveRepoRoot(), CACHE_RELATIVE_DIR);
}

function buildCacheKey(descriptionCategoryId: number, typeId: number): string {
  return `${descriptionCategoryId}_${typeId}_ZH_HANS.json`;
}

export async function readCategoryAttributesCache(
  descriptionCategoryId: number,
  typeId: number,
): Promise<CategoryAttributesV1 | null> {
  const cacheDir = resolveCacheDir();
  const cacheFile = path.join(cacheDir, buildCacheKey(descriptionCategoryId, typeId));
  try {
    const raw = await fs.readFile(cacheFile, 'utf8');
    return JSON.parse(raw) as CategoryAttributesV1;
  } catch {
    // Cache miss — file missing or unparseable
    return null;
  }
}

export async function writeCategoryAttributesCache(
  data: CategoryAttributesV1,
): Promise<void> {
  const cacheDir = resolveCacheDir();
  await fs.mkdir(cacheDir, { recursive: true });
  const finalName = buildCacheKey(data.category.description_category_id, data.category.type_id);
  const finalPath = path.join(cacheDir, finalName);
  const tmpName = `${finalName}.tmp-${process.pid}-${Date.now()}`;
  const tmpPath = path.join(cacheDir, tmpName);

  try {
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8');
    await fs.rename(tmpPath, finalPath);
  } finally {
    await fs.rm(tmpPath, { force: true });
  }
}

export async function deleteCategoryAttributesCache(
  descriptionCategoryId: number,
  typeId: number,
): Promise<void> {
  const cacheDir = resolveCacheDir();
  const cacheFile = path.join(cacheDir, buildCacheKey(descriptionCategoryId, typeId));
  try {
    await fs.unlink(cacheFile);
  } catch {
    // ignore if not cached
  }
}
