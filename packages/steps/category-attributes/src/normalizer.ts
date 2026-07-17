import type {
  CategoryAttributesV1,
  CategoryAttributeV1,
  CategoryAttributeValueV1,
  DictionaryPageRawV1,
} from '@auto-ozon/contracts';
import { createHash } from 'node:crypto';
import type { CategoryAttributesSelectionInput } from './service.js';

interface OzonRawAttribute {
  id: number;
  name: string;
  description: string;
  type: string;
  is_required: boolean;
  is_collection: boolean;
  is_aspect: boolean;
  dictionary_id: number;
  group_id: number;
  group_name: string;
  category_dependent: boolean;
}

interface OzonRawAttributeValue {
  id: number;
  value: string;
  info?: string;
  picture?: string;
}

export function normalizeCategoryAttributes(
  rawAttributes: unknown,
  dictionaryValues: Map<number, CategoryAttributeValueV1[]>,
  dictionaryRawResponses: Record<number, DictionaryPageRawV1[]>,
  options: CategoryAttributesSelectionInput,
): CategoryAttributesV1 {
  const attributes = normalizeAttributeList(rawAttributes, dictionaryValues);
  const capturedAt = new Date().toISOString();
  const validTo = new Date(Date.parse(capturedAt) + 24 * 60 * 60 * 1000).toISOString();
  return {
    schema_version: 1,
    source: 'ozon',
    language: 'ZH_HANS',
    ok: true,
    fetched_at: capturedAt,
    snapshot: {
      schema_version: 1, source: 'ozon-seller-api', captured_at: capturedAt,
      valid_from: capturedAt, valid_to: validTo,
      sha256: createHash('sha256').update(stableJson({ rawAttributes, dictionaryValues: [...dictionaryValues] })).digest('hex'),
    },
    category: {
      description_category_id: options.descriptionCategoryId,
      type_id: options.typeId,
      description_category_name: options.categoryName,
      type_name: options.typeName,
      category_path_zh: options.categoryPathZh,
    },
    attributes,
    raw_response: rawAttributes,
    dictionary_raw_responses: dictionaryRawResponses,
  };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
}

export function normalizeAttributeList(
  raw: unknown,
  dictionaryValues: Map<number, CategoryAttributeValueV1[]>,
): CategoryAttributeV1[] {
  const list = extractResultArray(raw);
  return list.map((item) => normalizeAttribute(item as unknown as OzonRawAttribute, dictionaryValues));
}

export function normalizeAttributeValues(
  raw: unknown,
): CategoryAttributeValueV1[] {
  const list = extractResultArray(raw);
  return list.map((item) => normalizeAttributeValue(item as unknown as OzonRawAttributeValue));
}

function normalizeAttribute(
  raw: OzonRawAttribute,
  dictionaryValues: Map<number, CategoryAttributeValueV1[]>,
): CategoryAttributeV1 {
  return {
    id: raw.id,
    name: raw.name ?? '',
    description: raw.description ?? '',
    type: raw.type ?? 'string',
    required: raw.is_required ?? false,
    is_collection: raw.is_collection ?? false,
    is_aspect: raw.is_aspect ?? false,
    dictionary_id: raw.dictionary_id ?? 0,
    group_id: raw.group_id ?? 0,
    group_name: raw.group_name ?? '',
    category_dependent: raw.category_dependent ?? false,
    values: dictionaryValues.get(raw.id) ?? [],
  };
}

function normalizeAttributeValue(raw: OzonRawAttributeValue): CategoryAttributeValueV1 {
  return {
    id: raw.id,
    value: raw.value ?? '',
    info: raw.info,
    picture: raw.picture,
  };
}

function extractResultArray(raw: unknown): Record<string, unknown>[] {
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as Record<string, unknown>;
  if (Array.isArray(obj)) return obj as unknown as Record<string, unknown>[];

  const result = obj.result;
  if (Array.isArray(result)) return result as Record<string, unknown>[];

  const data = obj.data;
  if (data && typeof data === 'object') {
    const dataObj = data as Record<string, unknown>;
    if (Array.isArray(dataObj.result)) return dataObj.result as Record<string, unknown>[];
    if (Array.isArray(dataObj.attributes)) return dataObj.attributes as Record<string, unknown>[];
  }
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  return [];
}
