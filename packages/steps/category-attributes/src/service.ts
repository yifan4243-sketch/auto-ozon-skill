import type {
  CategoryAttributesGroupV1,
  CategoryAttributesV1,
  CategoryDecisionV1,
  CommandResult,
  OzonCategorySelectionV1,
} from '@auto-ozon/contracts';
import type { WorkflowContext } from '@auto-ozon/artifact-store';
import { assertWorkflowActive } from '@auto-ozon/artifact-store';
import {
  OzonCategoryTransportError,
  withOzonCategoryAttributesTransport,
  type OzonCategoryAttributesTransport,
} from '@auto-ozon/adapters-ozon';
import { fetchAllAttributeValues } from './dictionary-fetcher.js';
import { normalizeCategoryAttributes } from './normalizer.js';

const BRAND_ATTRIBUTE_ID = 85;
const NO_BRAND_VALUE = { id: 126745801, value: '无品牌' } as const;

export interface CategoryAttributesSelectionInput {
  descriptionCategoryId: number;
  typeId: number;
  categoryName?: string;
  typeName?: string;
  categoryPathZh?: string[];
}

export interface RunCategoryAttributesInput {
  category_decision?: CategoryDecisionV1;
  selections?: Array<{
    group_ids: string[];
    category: CategoryAttributesSelectionInput;
  }>;
  force_refresh?: boolean;
  transport?: OzonCategoryAttributesTransport;
}

export async function runCategoryAttributes(
  input: RunCategoryAttributesInput,
  context?: WorkflowContext,
): Promise<CommandResult<CategoryAttributesGroupV1[]>> {
  try {
    if (context) {
      assertWorkflowActive(context);
      await context.artifact_store.updateStep(context.run_id, 'category-attributes', {
        status: 'running',
      });
    }
    const selections = collectSelections(input);
    if (selections.length === 0) {
      return fail('NO_DECIDED_CATEGORY', 'No selected category groups were supplied.', context);
    }

    const execute = async (transport: OzonCategoryAttributesTransport) => {
      const groups: CategoryAttributesGroupV1[] = [];
      for (const selection of selections) {
        const cacheKey = `${selection.category.descriptionCategoryId}-${selection.category.typeId}`;
        let schema =
          !effectiveForceRefresh(input, context) && context
            ? await context.artifact_store.readCache<CategoryAttributesV1>(
                'category-attributes',
                cacheKey,
              )
            : null;
        if (!schema) {
          schema = await fetchOne(transport, selection.category);
          if (context) {
            await context.artifact_store.writeCache('category-attributes', cacheKey, schema);
          }
        }
        const category = toSelection(selection.category);
        groups.push({ group_ids: selection.group_ids, category, attributes_schema: schema });
        if (context) {
          await context.artifact_store.write(
            context.run_id,
            'category-attributes',
            `${cacheKey}.json`,
            schema,
          );
        }
      }
      return groups;
    };

    const groups = input.transport
      ? await execute(input.transport)
      : await withOzonCategoryAttributesTransport(execute);

    if (context) {
      const output = await context.artifact_store.write(
        context.run_id,
        'category-attributes',
        'category-attributes-v1.json',
        groups,
      );
      await context.artifact_store.updateStep(context.run_id, 'category-attributes', {
        status: 'succeeded',
        output,
      });
    }
    return {
      ok: true,
      command: 'category.attributes',
      data: groups,
      warnings: [],
      errors: [],
      nextActions: [],
    };
  } catch (error) {
    const transportError = error instanceof OzonCategoryTransportError ? error : null;
    return fail(
      transportError?.code ?? 'CATEGORY_ATTRIBUTES_FAILED',
      transportError?.message ?? (error instanceof Error ? error.message : String(error)),
      context,
      transportError?.detail,
      transportError?.recoverable ?? true,
    );
  }
}

async function fetchOne(
  transport: OzonCategoryAttributesTransport,
  selection: CategoryAttributesSelectionInput,
): Promise<CategoryAttributesV1> {
  assertPositive(selection.descriptionCategoryId, 'descriptionCategoryId');
  assertPositive(selection.typeId, 'typeId');
  const raw = await transport.getAttributes(selection);
  const list = extractAttributeList(raw);
  if (!list) throw new Error('Ozon attribute response does not contain result[].');
  const values = new Map();
  const pages: CategoryAttributesV1['dictionary_raw_responses'] = {};
  for (const attribute of list.filter((item) => Number(item.dictionary_id) > 0)) {
    const attributeId = Number(attribute.id);
    assertPositive(attributeId, 'attributeId');
    if (attributeId === BRAND_ATTRIBUTE_ID) {
      values.set(attributeId, [{ ...NO_BRAND_VALUE }]);
      continue;
    }
    const dictionary = await fetchAllAttributeValues(transport, {
      descriptionCategoryId: selection.descriptionCategoryId,
      typeId: selection.typeId,
      attributeId,
    });
    values.set(attributeId, dictionary.values);
    pages[attributeId] = dictionary.pages;
  }
  return normalizeCategoryAttributes(raw, values, pages, selection);
}

function collectSelections(input: RunCategoryAttributesInput): Array<{
  group_ids: string[];
  category: CategoryAttributesSelectionInput;
}> {
  if (input.selections) return deduplicate(input.selections);
  if (!input.category_decision || input.category_decision.status === 'blocked') return [];
  return deduplicate(
    input.category_decision.category_groups.flatMap((group) =>
      group.selected_category
        ? [{
            group_ids: [group.group_id],
            category: {
              descriptionCategoryId: group.selected_category.description_category_id,
              typeId: group.selected_category.type_id,
              categoryName: group.selected_category.description_category_name,
              typeName: group.selected_category.type_name,
              categoryPathZh: group.selected_category.category_path_zh,
            },
          }]
        : [],
    ),
  );
}

function deduplicate(
  selections: Array<{ group_ids: string[]; category: CategoryAttributesSelectionInput }>,
): Array<{ group_ids: string[]; category: CategoryAttributesSelectionInput }> {
  const pairs = new Map<string, { group_ids: string[]; category: CategoryAttributesSelectionInput }>();
  for (const selection of selections) {
    const key = `${selection.category.descriptionCategoryId}:${selection.category.typeId}`;
    const existing = pairs.get(key);
    if (existing) {
      existing.group_ids.push(...selection.group_ids.filter((id) => !existing.group_ids.includes(id)));
    } else {
      pairs.set(key, { group_ids: [...selection.group_ids], category: selection.category });
    }
  }
  return [...pairs.values()];
}

function toSelection(input: CategoryAttributesSelectionInput): OzonCategorySelectionV1 {
  return {
    description_category_id: input.descriptionCategoryId,
    description_category_name: input.categoryName ?? '',
    type_id: input.typeId,
    type_name: input.typeName ?? '',
    category_path_zh: input.categoryPathZh ?? [],
  };
}

function extractAttributeList(value: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(value)) return value as Record<string, unknown>[];
  if (value && typeof value === 'object' && Array.isArray((value as { result?: unknown }).result)) {
    return (value as { result: Record<string, unknown>[] }).result;
  }
  return null;
}

function assertPositive(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${field} must be positive.`);
}

function effectiveForceRefresh(
  input: RunCategoryAttributesInput,
  context?: WorkflowContext,
): boolean {
  return input.force_refresh === true || context?.force_refresh === true;
}

async function fail(
  code: string,
  message: string,
  context?: WorkflowContext,
  detail?: unknown,
  recoverable = true,
): Promise<CommandResult<CategoryAttributesGroupV1[]>> {
  if (context) {
    await context.artifact_store.updateStep(context.run_id, 'category-attributes', {
      status: 'failed',
      error_code: code,
    });
  }
  return {
    ok: false,
    command: 'category.attributes',
    warnings: [],
    errors: [{ code, message, detail, recoverable }],
    nextActions: [],
  };
}
