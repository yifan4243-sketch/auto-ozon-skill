import type { CategoryAttributesV1, CommandResult } from '@auto-ozon/contracts';
import { runCategoryAttributes } from '@auto-ozon/step-category-attributes';
import { saveCategoryAttributesSnapshot } from '@auto-ozon/core';

export interface RunStandaloneCategoryAttributesInput {
  offer_id: string;
  description_category_id: number | undefined;
  type_id: number | undefined;
  products_dir?: string;
}

export async function runStandaloneCategoryAttributes(
  input: RunStandaloneCategoryAttributesInput,
): Promise<CommandResult<CategoryAttributesV1>> {
  const offerId = input.offer_id.trim();
  if (
    !/^\d+$/.test(offerId) ||
    offerId === '0' ||
    !isPositiveInteger(input.description_category_id) ||
    !isPositiveInteger(input.type_id)
  ) {
    return {
      ok: false,
      command: 'category.attributes',
      warnings: [],
      errors: [{
        code: 'BAD_INPUT',
        message: '--offer-id, --category-id and --type-id must be valid positive integers.',
        recoverable: false,
      }],
      nextActions: [],
    };
  }
  const step = await runCategoryAttributes({
    selections: [{
      group_ids: [],
      category: {
        descriptionCategoryId: input.description_category_id,
        typeId: input.type_id,
      },
    }],
  });
  const schema = step.data?.[0]?.attributes_schema;
  if (!step.ok || !schema) {
    return {
      ok: false,
      command: step.command,
      warnings: step.warnings,
      errors: step.errors,
      nextActions: step.nextActions,
    };
  }
  try {
    await saveCategoryAttributesSnapshot(
      { offerId, productsDir: input.products_dir },
      [{ group_ids: [], attributes_schema: schema }],
    );
  } catch (error) {
    return {
      ok: false,
      command: 'category.attributes',
      data: schema,
      warnings: step.warnings,
      errors: [{
        code: 'PRODUCT_WORKSPACE_WRITE_FAILED',
        message: error instanceof Error ? error.message : String(error),
        recoverable: false,
      }],
      nextActions: [],
    };
  }
  return {
    ok: true,
    command: 'category.attributes',
    data: schema,
    warnings: step.warnings,
    errors: [],
    nextActions: [],
  };
}

function isPositiveInteger(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0;
}
