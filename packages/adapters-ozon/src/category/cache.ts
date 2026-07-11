import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CategoryAttributesV1 } from '../../../contracts/src/category-attributes.js';

const CACHE_DIR = 'data/cache/ozon/category-attributes';

function buildCacheKey(descriptionCategoryId: number, typeId: number): string {
  return `${descriptionCategoryId}_${typeId}_ZH_HANS.json`;
}

function resolveCacheDir(): string {
  const candidates = [
    path.resolve(process.cwd(), CACHE_DIR),
    path.resolve(process.cwd(), '..', '..', CACHE_DIR),
    path.resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..', CACHE_DIR),
  ];
  // Use the first candidate that is inside an existing parent directory tree.
  // Prefer the cwd-based path as that's where CLI commands run from.
  return candidates[0];
}

function resolveProjectRoot(cacheDir: string): string {
  // cacheDir is <root>/data/cache/ozon/category-attributes, root is 4 levels up
  return path.resolve(cacheDir, '..', '..', '..', '..');
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
    return null;
  }
}

export async function writeCategoryAttributesCache(
  data: CategoryAttributesV1,
): Promise<void> {
  const cacheDir = resolveCacheDir();
  await fs.mkdir(cacheDir, { recursive: true });
  const cacheFile = path.join(
    cacheDir,
    buildCacheKey(data.category.description_category_id, data.category.type_id),
  );
  await fs.writeFile(cacheFile, JSON.stringify(data, null, 2), 'utf8');
}
