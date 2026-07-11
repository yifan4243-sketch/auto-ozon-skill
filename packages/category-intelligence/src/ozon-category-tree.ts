import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OzonCategorySelectionV1 } from '../../contracts/src/category-decision.js';

interface OzonCategoryNode {
  description_category_id?: number;
  category_name?: string;
  type_id?: number;
  type_name?: string;
  disabled?: boolean;
  children?: OzonCategoryNode[];
}

export interface OzonCategoryTreeDocument {
  result: OzonCategoryNode[];
}

export interface OzonCategoryRecord extends OzonCategorySelectionV1 {
  disabled: boolean;
}

export interface OzonCategorySearchResult extends OzonCategoryRecord {
  score: number;
}

export interface OzonCategoryTreeStats {
  root_count: number;
  description_category_count: number;
  type_count: number;
  disabled_description_category_count: number;
  disabled_type_count: number;
}

export interface OzonCategoryPairValidation {
  valid: boolean;
  category: OzonCategoryRecord | null;
  code: 'VALID' | 'CATEGORY_PAIR_NOT_FOUND' | 'CATEGORY_DISABLED';
  message: string;
}

export async function loadOzonCategoryTree(
  filePath = resolveDefaultCategoryTreePath(),
): Promise<OzonCategoryTreeDocument> {
  const raw = await fs.readFile(filePath, 'utf8');
  const parsed = JSON.parse(raw) as Partial<OzonCategoryTreeDocument>;
  if (!Array.isArray(parsed.result)) {
    throw new Error(`Invalid Ozon category tree: result[] missing in ${filePath}`);
  }
  return { result: parsed.result };
}

export async function loadOzonCategoryIndex(
  filePath = resolveDefaultCategoryTreePath(),
): Promise<OzonCategoryRecord[]> {
  return flattenOzonCategoryTree(await loadOzonCategoryTree(filePath));
}

export function flattenOzonCategoryTree(
  document: OzonCategoryTreeDocument,
): OzonCategoryRecord[] {
  const records: OzonCategoryRecord[] = [];
  const pending: Array<{
    node: OzonCategoryNode;
    path: string[];
    descriptionCategoryId: number | null;
    descriptionCategoryName: string | null;
    ancestorDisabled: boolean;
  }> = document.result.map((node) => ({
    node,
    path: [],
    descriptionCategoryId: null,
    descriptionCategoryName: null,
    ancestorDisabled: false,
  }));

  while (pending.length > 0) {
    const current = pending.shift()!;
    const nodeDisabled = current.ancestorDisabled || current.node.disabled === true;
    if (
      Number.isFinite(current.node.description_category_id) &&
      typeof current.node.category_name === 'string'
    ) {
      const categoryPath = [...current.path, current.node.category_name];
      for (const child of current.node.children ?? []) {
        pending.push({
          node: child,
          path: categoryPath,
          descriptionCategoryId: current.node.description_category_id!,
          descriptionCategoryName: current.node.category_name,
          ancestorDisabled: nodeDisabled,
        });
      }
      continue;
    }

    if (
      Number.isFinite(current.node.type_id) &&
      typeof current.node.type_name === 'string' &&
      current.descriptionCategoryId !== null &&
      current.descriptionCategoryName !== null
    ) {
      records.push({
        description_category_id: current.descriptionCategoryId,
        description_category_name: current.descriptionCategoryName,
        type_id: current.node.type_id!,
        type_name: current.node.type_name,
        category_path_zh: [...current.path, current.node.type_name],
        disabled: nodeDisabled,
      });
    }
  }

  return records;
}

export function getOzonCategoryTreeStats(
  document: OzonCategoryTreeDocument,
): OzonCategoryTreeStats {
  let descriptionCategoryCount = 0;
  let typeCount = 0;
  let disabledDescriptionCategoryCount = 0;
  let disabledTypeCount = 0;
  const pending = document.result.map((node) => ({ node, ancestorDisabled: false }));

  while (pending.length > 0) {
    const current = pending.shift()!;
    const disabled = current.ancestorDisabled || current.node.disabled === true;
    if (Number.isFinite(current.node.description_category_id)) {
      descriptionCategoryCount++;
      if (disabled) disabledDescriptionCategoryCount++;
    } else if (Number.isFinite(current.node.type_id)) {
      typeCount++;
      if (disabled) disabledTypeCount++;
    }
    for (const child of current.node.children ?? []) {
      pending.push({ node: child, ancestorDisabled: disabled });
    }
  }

  return {
    root_count: document.result.length,
    description_category_count: descriptionCategoryCount,
    type_count: typeCount,
    disabled_description_category_count: disabledDescriptionCategoryCount,
    disabled_type_count: disabledTypeCount,
  };
}

export function searchOzonCategories(
  index: readonly OzonCategoryRecord[],
  query: string,
  limit = 20,
): OzonCategorySearchResult[] {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery || limit <= 0) return [];

  return index
    .filter((category) => !category.disabled)
    .map((category) => ({ ...category, score: categorySearchScore(category, normalizedQuery) }))
    .filter((category) => category.score > 0)
    .sort((left, right) => {
      if (left.score !== right.score) return right.score - left.score;
      const pathOrder = left.category_path_zh.join(' > ').localeCompare(
        right.category_path_zh.join(' > '),
        'zh-CN',
      );
      if (pathOrder !== 0) return pathOrder;
      if (left.description_category_id !== right.description_category_id) {
        return left.description_category_id - right.description_category_id;
      }
      return left.type_id - right.type_id;
    })
    .slice(0, Math.floor(limit));
}

export function validateOzonCategoryPair(
  index: readonly OzonCategoryRecord[],
  descriptionCategoryId: number,
  typeId: number,
): OzonCategoryPairValidation {
  const category =
    index.find(
      (entry) =>
        entry.description_category_id === descriptionCategoryId &&
        entry.type_id === typeId,
    ) ?? null;
  if (!category) {
    return {
      valid: false,
      category: null,
      code: 'CATEGORY_PAIR_NOT_FOUND',
      message: `Ozon category pair not found: ${descriptionCategoryId}/${typeId}`,
    };
  }
  if (category.disabled) {
    return {
      valid: false,
      category,
      code: 'CATEGORY_DISABLED',
      message: `Ozon category pair is disabled: ${descriptionCategoryId}/${typeId}`,
    };
  }
  return {
    valid: true,
    category,
    code: 'VALID',
    message: 'Ozon category pair is valid.',
  };
}

export function resolveDefaultCategoryTreePath(): string {
  const explicit = process.env.OZON_CATEGORY_TREE_PATH?.trim();
  if (explicit) return path.resolve(explicit);

  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(process.cwd(), 'data/ozon/categories/ozon-category-tree.json'),
    path.resolve(process.cwd(), '../../data/ozon/categories/ozon-category-tree.json'),
    path.resolve(moduleDir, '../../../data/ozon/categories/ozon-category-tree.json'),
    path.resolve(moduleDir, '../../../../data/ozon/categories/ozon-category-tree.json'),
  ];
  const found = candidates.find((candidate) => fsSync.existsSync(candidate));
  if (!found) {
    throw new Error(
      `Ozon category tree not found. Checked: ${candidates.join(', ')}`,
    );
  }
  return found;
}

function categorySearchScore(
  category: OzonCategoryRecord,
  normalizedQuery: string,
): number {
  const typeName = normalizeSearchText(category.type_name);
  const descriptionName = normalizeSearchText(category.description_category_name);
  const pathText = normalizeSearchText(category.category_path_zh.join(' '));
  if (typeName === normalizedQuery) return 100;
  if (typeName.startsWith(normalizedQuery)) return 90;
  if (typeName.includes(normalizedQuery)) return 80;
  if (descriptionName === normalizedQuery) return 70;
  if (descriptionName.includes(normalizedQuery)) return 60;
  if (pathText.includes(normalizedQuery)) return 50;
  return 0;
}

function normalizeSearchText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}
