import type {
  CategoryAttributeValueV1,
  DictionaryPageRawV1,
} from '@auto-ozon/contracts';
import type { OzonCategoryAttributesTransport } from '@auto-ozon/adapters-ozon';
import { normalizeAttributeValues } from './normalizer.js';

export interface DictionaryFetchResult {
  values: CategoryAttributeValueV1[];
  pages: DictionaryPageRawV1[];
}

export async function fetchAllAttributeValues(
  transport: OzonCategoryAttributesTransport,
  input: {
    descriptionCategoryId: number;
    typeId: number;
    attributeId: number;
  },
): Promise<DictionaryFetchResult> {
  const values: CategoryAttributeValueV1[] = [];
  const pages: DictionaryPageRawV1[] = [];
  const seen = new Set<number>();
  let lastValueId = 0;

  while (true) {
    const raw = await transport.getAttributeValuesPage({
      ...input,
      lastValueId,
      limit: 200,
    });
    if (!isDictionaryPage(raw)) {
      throw new Error(
        `Dictionary response must contain result[] and boolean has_next at attribute_id=${input.attributeId}, last_value_id=${lastValueId}.`,
      );
    }
    const batch = normalizeAttributeValues(raw);
    pages.push({ last_value_id: lastValueId, response: raw });
    const fresh = batch.filter((value) => {
      if (!Number.isSafeInteger(value.id) || value.id <= 0) {
        throw new Error(`Dictionary attribute ${input.attributeId} returned an invalid value ID.`);
      }
      if (seen.has(value.id)) return false;
      seen.add(value.id);
      return true;
    });

    if (batch.length > 0 && fresh.length === 0) {
      throw new Error(`Dictionary cursor stalled for attribute ${input.attributeId}.`);
    }
    values.push(...fresh);

    if (!raw.has_next) return { values, pages };
    if (batch.length === 0) {
      throw new Error(`Dictionary attribute ${input.attributeId} returned an empty continuing page.`);
    }
    const next = batch[batch.length - 1]!.id;
    if (next <= lastValueId) {
      throw new Error(`Dictionary cursor did not advance for attribute ${input.attributeId}.`);
    }
    lastValueId = next;
  }
}

function isDictionaryPage(value: unknown): value is { result: unknown[]; has_next: boolean } {
  return Boolean(
    value &&
      typeof value === 'object' &&
      Array.isArray((value as { result?: unknown }).result) &&
      typeof (value as { has_next?: unknown }).has_next === 'boolean',
  );
}
