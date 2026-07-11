import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CategoryAttributesV1 } from '../../../packages/contracts/src/category-attributes.js';
import { validateCategoryDecisionSchema } from '../../../packages/category-intelligence/src/category-decision-schema.js';

const mcp = vi.hoisted(() => ({
  listTools: vi.fn(),
  callTool: vi.fn(),
}));
const cache = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
}));

vi.mock('../../../packages/adapters-ozon/src/mcp/pcdck-client.js', () => ({
  withPcdckClient: async <T>(fn: (client: unknown) => Promise<T>) =>
    fn({ listTools: mcp.listTools, callTool: mcp.callTool }),
}));

vi.mock('../../../packages/adapters-ozon/src/category/cache.js', () => ({
  readCategoryAttributesCache: cache.read,
  writeCategoryAttributesCache: cache.write,
}));

import { getCategoryAttributes } from '../../../packages/adapters-ozon/src/category/category-attributes.js';
import { normalizeAttributeValues } from '../../../packages/adapters-ozon/src/category/normalizer.js';

beforeEach(() => {
  vi.clearAllMocks();
  cache.read.mockResolvedValue(null);
  cache.write.mockResolvedValue(undefined);
  mcp.listTools.mockResolvedValue({ tools: [{ name: 'ozon_call_method' }] });
});

describe('normalizeAttributeValues', () => {
  it('parses ZH_HANS attribute values', () => {
    const result = normalizeAttributeValues({
      result: [
        { id: 1, value: '中国', info: 'Китай' },
        { id: 2, value: '红色', picture: 'https://img.example.com/red.jpg' },
      ],
    });
    expect(result).toEqual([
      { id: 1, value: '中国', info: 'Китай', picture: undefined },
      { id: 2, value: '红色', info: undefined, picture: 'https://img.example.com/red.jpg' },
    ]);
  });

  it('handles empty and null inputs', () => {
    expect(normalizeAttributeValues({ result: [] })).toEqual([]);
    expect(normalizeAttributeValues(null)).toEqual([]);
  });
});

describe('getCategoryAttributes MCP response and pagination', () => {
  it('unwraps real ozon-mcp envelopes and fetches every dictionary page', async () => {
    mockReadSafetyAndAttributes();
    mcp.callTool
      .mockResolvedValueOnce(dictionaryPage([{ id: 10, value: '红色' }], true))
      .mockResolvedValueOnce(
        dictionaryPage(
          [
            { id: 10, value: '红色' },
            { id: 20, value: '蓝色' },
          ],
          false,
        ),
      );

    const result = await getCategoryAttributes(validOptions());

    expect(result.ok).toBe(true);
    expect(result.data?.attributes[0]?.values).toEqual([
      { id: 10, value: '红色', info: undefined, picture: undefined },
      { id: 20, value: '蓝色', info: undefined, picture: undefined },
    ]);
    expect(result.data?.raw_response).toEqual({
      result: [rawDictionaryAttribute()],
    });
    expect(result.data?.dictionary_raw_responses[100]).toHaveLength(2);
    expect(mcp.callTool).toHaveBeenLastCalledWith('ozon_call_method', {
      operation_id: 'DescriptionCategoryAPI_GetAttributeValues',
      params: {
        description_category_id: 17028741,
        type_id: 92499,
        attribute_id: 100,
        language: 'ZH_HANS',
        last_value_id: 10,
        limit: 200,
      },
    });
    expect(cache.write).toHaveBeenCalledOnce();
  });

  it('rejects an empty page that claims another page exists', async () => {
    mockReadSafetyAndAttributes();
    mcp.callTool.mockResolvedValueOnce(dictionaryPage([], true));

    const result = await getCategoryAttributes(validOptions());

    expect(result).toMatchObject({
      ok: false,
      errors: [{ code: 'DICTIONARY_FETCH_FAILED' }],
    });
    expect(result.errors[0]?.message).toContain('attribute 100');
    expect(result.errors[0]?.message).toContain('17028741/92499');
    expect(cache.write).not.toHaveBeenCalled();
  });

  it('rejects a repeated dictionary page instead of looping', async () => {
    mockReadSafetyAndAttributes();
    mcp.callTool
      .mockResolvedValueOnce(dictionaryPage([{ id: 10, value: '红色' }], true))
      .mockResolvedValueOnce(dictionaryPage([{ id: 10, value: '红色' }], true));

    const result = await getCategoryAttributes(validOptions());

    expect(result).toMatchObject({
      ok: false,
      errors: [{ code: 'DICTIONARY_FETCH_FAILED' }],
    });
    expect(result.errors[0]?.message).toContain('cursor stalled');
    expect(cache.write).not.toHaveBeenCalled();
  });

  it('rejects malformed success envelopes instead of caching empty attributes', async () => {
    mockReadSafety();
    mcp.callTool.mockResolvedValueOnce({ structuredContent: { ok: true } });

    const result = await getCategoryAttributes(validOptions());

    expect(result).toMatchObject({
      ok: false,
      errors: [{ code: 'OZON_RESPONSE_INVALID' }],
    });
    expect(cache.write).not.toHaveBeenCalled();
  });

  it('returns a cache hit without starting MCP and bypasses it on refresh', async () => {
    const cached = cachedAttributes();
    cache.read.mockResolvedValue(cached);

    const hit = await getCategoryAttributes({
      descriptionCategoryId: 17028741,
      typeId: 92499,
    });

    expect(hit.data).toEqual(cached);
    expect(mcp.listTools).not.toHaveBeenCalled();
    expect(cache.read).toHaveBeenCalledOnce();

    vi.clearAllMocks();
    mockReadSafetyAndAttributes(false);
    const refreshed = await getCategoryAttributes(validOptions());
    expect(refreshed.ok).toBe(true);
    expect(cache.read).not.toHaveBeenCalled();
    expect(cache.write).toHaveBeenCalledOnce();
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid category identifier %s before cache or MCP access',
    async (descriptionCategoryId) => {
      const result = await getCategoryAttributes({
        descriptionCategoryId,
        typeId: 92499,
      });

      expect(result).toMatchObject({
        ok: false,
        errors: [{ code: 'BAD_INPUT', recoverable: false }],
      });
      expect(cache.read).not.toHaveBeenCalled();
      expect(mcp.listTools).not.toHaveBeenCalled();
    },
  );
});

describe('CategoryDecisionV1 schema validation', () => {
  it('rejects null and empty objects', () => {
    expect(validateCategoryDecisionSchema(null).valid).toBe(false);
    expect(validateCategoryDecisionSchema({}).valid).toBe(false);
  });
});

function mockReadSafety(): void {
  mcp.callTool
    .mockResolvedValueOnce({
      structuredContent: {
        operation_id: 'DescriptionCategoryAPI_GetAttributes',
        safety: 'read',
      },
    })
    .mockResolvedValueOnce({
      structuredContent: {
        operation_id: 'DescriptionCategoryAPI_GetAttributeValues',
        safety: 'read',
      },
    });
}

function mockReadSafetyAndAttributes(hasDictionary = true): void {
  mockReadSafety();
  mcp.callTool.mockResolvedValueOnce({
    structuredContent: {
      ok: true,
      response: {
        result: [
          hasDictionary
            ? rawDictionaryAttribute()
            : { ...rawDictionaryAttribute(), dictionary_id: 0 },
        ],
      },
    },
  });
}

function dictionaryPage(
  result: Array<{ id: number; value: string }>,
  hasNext: boolean,
): unknown {
  return {
    structuredContent: {
      ok: true,
      response: { result, has_next: hasNext },
    },
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

function validOptions() {
  return {
    descriptionCategoryId: 17028741,
    typeId: 92499,
    forceRefresh: true,
  };
}

function cachedAttributes(): CategoryAttributesV1 {
  return {
    schema_version: 1,
    source: 'ozon',
    language: 'ZH_HANS',
    ok: true,
    fetched_at: '2026-07-11T00:00:00.000Z',
    category: {
      description_category_id: 17028741,
      type_id: 92499,
    },
    attributes: [],
    raw_response: { result: [] },
    dictionary_raw_responses: {},
  };
}
