import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OzonCategoryAttributesTransport } from '../../../../packages/adapters-ozon/src/index.js';
import {
  FileArtifactStore,
  silentWorkflowLogger,
} from '../../../../packages/artifact-store/src/index.js';
import {
  normalizeAttributeValues,
} from '../../../../packages/steps/category-attributes/src/normalizer.js';
import {
  runCategoryAttributes,
} from '../../../../packages/steps/category-attributes/src/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('category-attributes normalization', () => {
  it('parses Chinese dictionary values', () => {
    expect(normalizeAttributeValues({
      result: [
        { id: 1, value: '中国', info: 'Китай' },
        { id: 2, value: '红色', picture: 'https://img.example.com/red.jpg' },
      ],
    })).toEqual([
      { id: 1, value: '中国', info: 'Китай', picture: undefined },
      { id: 2, value: '红色', info: undefined, picture: 'https://img.example.com/red.jpg' },
    ]);
  });
});

describe('runCategoryAttributes', () => {
  it('deduplicates category pairs, preserves group IDs, and fetches every dictionary page', async () => {
    const transport = fakeTransport([
      { result: [{ id: 10, value: '红色' }], has_next: true },
      { result: [{ id: 10, value: '红色' }, { id: 20, value: '蓝色' }], has_next: false },
    ]);

    const result = await runCategoryAttributes({
      selections: [selection('group-a'), selection('group-b')],
      transport,
    });

    expect(result.ok).toBe(true);
    expect(result.data).toHaveLength(1);
    expect(result.data?.[0]?.group_ids).toEqual(['group-a', 'group-b']);
    expect(result.data?.[0]?.attributes_schema.attributes[0]?.values).toEqual([
      { id: 10, value: '红色', info: undefined, picture: undefined },
      { id: 20, value: '蓝色', info: undefined, picture: undefined },
    ]);
    expect(transport.getAttributes).toHaveBeenCalledTimes(1);
    expect(transport.getAttributeValuesPage).toHaveBeenCalledTimes(2);
  });

  it('uses separated cache on later runs unless force refresh is requested', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-ozon-attrs-'));
    temporaryDirectories.push(root);
    const store = new FileArtifactStore({
      repoRoot: root,
      runsRoot: path.join(root, 'runs'),
      cacheRoot: path.join(root, 'cache'),
    });
    const firstTransport = fakeTransport([
      { result: [{ id: 10, value: '红色' }], has_next: false },
    ]);
    const first = await runCategoryAttributes(
      { selections: [selection('group-a')], transport: firstTransport },
      context('run-1', store),
    );
    expect(first.ok).toBe(true);

    const cachedTransport = fakeTransport([]);
    const cached = await runCategoryAttributes(
      { selections: [selection('group-a')], transport: cachedTransport },
      context('run-2', store),
    );
    expect(cached.ok).toBe(true);
    expect(cachedTransport.getAttributes).not.toHaveBeenCalled();
    expect(await store.exists('run-2', 'category-attributes', 'category-attributes-v1.json')).toBe(true);

    const refreshedTransport = fakeTransport([
      { result: [{ id: 20, value: '蓝色' }], has_next: false },
    ]);
    const refreshed = await runCategoryAttributes(
      {
        selections: [selection('group-a')],
        transport: refreshedTransport,
        force_refresh: true,
      },
      context('run-3', store),
    );
    expect(refreshed.ok).toBe(true);
    expect(refreshedTransport.getAttributes).toHaveBeenCalledOnce();
  });

  it('fails safely on empty continuing and repeated dictionary pages', async () => {
    const empty = await runCategoryAttributes({
      selections: [selection('group-a')],
      transport: fakeTransport([{ result: [], has_next: true }]),
    });
    expect(empty).toMatchObject({ ok: false, errors: [{ code: 'CATEGORY_ATTRIBUTES_FAILED' }] });
    expect(empty.errors[0]?.message).toContain('empty continuing page');

    const repeated = await runCategoryAttributes({
      selections: [selection('group-a')],
      transport: fakeTransport([
        { result: [{ id: 10, value: '红色' }], has_next: true },
        { result: [{ id: 10, value: '红色' }], has_next: true },
      ]),
    });
    expect(repeated.ok).toBe(false);
    expect(repeated.errors[0]?.message).toContain('cursor stalled');
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid category identifier %s before transport access',
    async (descriptionCategoryId) => {
      const transport = fakeTransport([]);
      const result = await runCategoryAttributes({
        selections: [{
          group_ids: ['group-a'],
          category: { descriptionCategoryId, typeId: 92499 },
        }],
        transport,
      });
      expect(result.ok).toBe(false);
      expect(transport.getAttributes).not.toHaveBeenCalled();
    },
  );
});

function selection(groupId: string) {
  return {
    group_ids: [groupId],
    category: {
      descriptionCategoryId: 17028741,
      typeId: 92499,
      categoryName: '餐具',
      typeName: '杯碟套装',
      categoryPathZh: ['家居', '餐具', '杯碟套装'],
    },
  };
}

function fakeTransport(pages: unknown[]): OzonCategoryAttributesTransport & {
  getAttributes: ReturnType<typeof vi.fn>;
  getAttributeValuesPage: ReturnType<typeof vi.fn>;
} {
  return {
    getAttributes: vi.fn().mockResolvedValue({ result: [rawDictionaryAttribute()] }),
    getAttributeValuesPage: vi.fn().mockImplementation(async () => {
      if (pages.length === 0) throw new Error('Unexpected dictionary request.');
      return pages.shift();
    }),
  };
}

function rawDictionaryAttribute(): Record<string, unknown> {
  return {
    id: 100,
    name: '颜色',
    description: '商品颜色',
    type: 'String',
    is_required: true,
    is_collection: false,
    is_aspect: false,
    dictionary_id: 200,
    group_id: 300,
    group_name: '基本属性',
    category_dependent: true,
  };
}

function context(runId: string, store: FileArtifactStore) {
  return {
    run_id: runId,
    artifact_store: store,
    logger: silentWorkflowLogger,
    force_refresh: false,
  };
}
