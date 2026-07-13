import { search1688ByKeywordV2 } from '../../../../packages/adapters-1688/src/client.js';
import { runCategoryAttributes } from '@auto-ozon/step-category-attributes';
import type { CategoryDecisionV1, OzonCategorySelectionV1 } from '../../../../packages/contracts/src/category-decision.js';
import type { CategoryAttributesV1 } from '../../../../packages/contracts/src/category-attributes.js';
import type { CommandResult } from '../../../../packages/contracts/src/command-result.js';
import {
  FileDecisionProvider,
  loadOzonCategoryIndex,
  validateCategoryDecision,
  validateCategoryDecisionSchema,
  type CategoryDecisionProvider,
} from '@auto-ozon/step-category-decision';
import {
  resolveProductsRoot,
} from '../../../../packages/core/src/product-workspace.js';
import {
  saveCategoryAttributesSnapshot,
  saveCategoryDecisionSnapshot,
} from '../../../../packages/publishing/src/draft-store.js';

export interface CategoryInspectOptions {
  keyword: string;
  max: number;
  skuMax?: number;
  decisionFile?: string;
  decisionProvider?: CategoryDecisionProvider;
  productsDir?: string;
}

export interface CategoryAttributesGroupResultV1 {
  group_ids: string[];
  category: OzonCategorySelectionV1;
  attributes_schema: CategoryAttributesV1;
}

export interface CategoryInspectResult {
  source: unknown;
  category_decision?: CategoryDecisionV1;
  category_attributes?: CategoryAttributesGroupResultV1[];
}

export async function runCategoryInspect(
  options: CategoryInspectOptions,
): Promise<CommandResult<CategoryInspectResult>> {
  const productsDir = resolveProductsRoot(options.productsDir);
  // Only single product supported in V0
  if (options.max !== 1) {
    return {
      ok: false,
      command: 'workflow.category.inspect',
      warnings: [],
      errors: [
        {
          code: 'CATEGORY_INSPECT_SINGLE_PRODUCT_ONLY',
          message: 'workflow category inspect currently supports exactly one sourced product (--max 1).',
          recoverable: true,
        },
      ],
      nextActions: [],
    };
  }

  // Step 1: 1688 sourcing → CanonicalProductV2
  const sourceResult = await search1688ByKeywordV2({
    keyword: options.keyword,
    max: options.max,
    skuMax: options.skuMax,
    sort: 'relevance',
    productsDir,
  });

  if (!sourceResult.ok) {
    return {
      ok: false,
      command: 'workflow.category.inspect',
      warnings: [],
      errors: sourceResult.errors,
      nextActions: [],
    };
  }

  const sourceData = sourceResult.data;

  // Determine the decision provider
  let provider: CategoryDecisionProvider | null = null;
  if (options.decisionProvider) {
    provider = options.decisionProvider;
  } else if (options.decisionFile) {
    provider = new FileDecisionProvider(options.decisionFile);
  }

  if (!provider) {
    return {
      ok: true,
      command: 'workflow.category.inspect',
      data: { source: sourceData },
      warnings: [
        {
          code: 'NO_DECISION_PROVIDER',
          message: 'No --decision-file supplied. Provide --decision-file to complete the pipeline.',
        },
      ],
      errors: [],
      nextActions: [
        'Run the CategoryDecision Agent on the source CanonicalProductV2 output.',
        'Save the decision as a JSON file and re-run with --decision-file <path>.',
      ],
    };
  }

  // Step 2: Load and validate CategoryDecisionV1
  let decision: CategoryDecisionV1;
  try {
    decision = await provider.load();
  } catch (error) {
    return {
      ok: false,
      command: 'workflow.category.inspect',
      data: { source: sourceData },
      warnings: [],
      errors: [
        {
          code: 'DECISION_LOAD_FAILED',
          message: `Failed to load CategoryDecisionV1: ${String(error)}`,
          recoverable: true,
        },
      ],
      nextActions: [],
    };
  }

  // Validate JSON schema structure
  const schemaValidation = validateCategoryDecisionSchema(decision);
  if (!schemaValidation.valid) {
    return {
      ok: false,
      command: 'workflow.category.inspect',
      data: { source: sourceData },
      warnings: [],
      errors: [
        {
          code: 'CATEGORY_DECISION_SCHEMA_INVALID',
          message: `CategoryDecisionV1 schema validation failed: ${schemaValidation.errors.length} error(s)`,
          recoverable: true,
          detail: { schema_errors: schemaValidation.errors.slice(0, 10) },
        },
      ],
      nextActions: [],
    };
  }

  // Extract the single CanonicalProductV2 from source
  const srcAny = sourceData as unknown as { items?: Array<unknown> };
  const product = srcAny?.items?.[0];
  if (!product) {
    return {
      ok: false,
      command: 'workflow.category.inspect',
      data: { source: sourceData, category_decision: decision },
      warnings: [],
      errors: [
        {
          code: 'NO_PRODUCT_IN_SOURCE',
          message: 'No product found in source result items[0].',
          recoverable: true,
        },
      ],
      nextActions: [],
    };
  }

  // Load Ozon category index and run full validation
  let categoryIndex;
  try {
    categoryIndex = await loadOzonCategoryIndex();
  } catch (error) {
    return {
      ok: false,
      command: 'workflow.category.inspect',
      data: { source: sourceData, category_decision: decision },
      warnings: [],
      errors: [
        {
          code: 'CATEGORY_INDEX_LOAD_FAILED',
          message: `Failed to load Ozon category tree: ${String(error)}`,
          recoverable: true,
        },
      ],
      nextActions: [],
    };
  }

  const validation = validateCategoryDecision(decision, product as never, categoryIndex);
  if (!validation.valid) {
    return {
      ok: false,
      command: 'workflow.category.inspect',
      data: { source: sourceData, category_decision: decision },
      warnings: [],
      errors: [
        {
          code: 'CATEGORY_DECISION_VALIDATION_FAILED',
          message: `CategoryDecision validation failed with ${validation.violations.length} violation(s).`,
          recoverable: true,
          detail: { violations: validation.violations },
        },
      ],
      nextActions: [],
    };
  }

  const sourceOfferId = decision.source_offer_id;
  try {
    await saveCategoryDecisionSnapshot({ offerId: sourceOfferId, productsDir }, decision);
  } catch (error) {
    return productWorkspaceWriteFailure(sourceData, decision, error);
  }

  // Step 3: Collect unique category pairs from all decided groups, preserving group_ids
  const decidedGroups = decision.category_groups.filter((g) => g.selected_category !== null);
  if (!decidedGroups.length) {
    return {
      ok: false,
      command: 'workflow.category.inspect',
      data: { source: sourceData, category_decision: decision },
      warnings: [],
      errors: [
        {
          code: 'NO_DECIDED_CATEGORY',
          message: 'CategoryDecisionV1 has no category group with a selected_category.',
          recoverable: true,
        },
      ],
      nextActions: [],
    };
  }

  const pairMap = new Map<string, { selection: OzonCategorySelectionV1; groupIds: string[] }>();
  for (const group of decidedGroups) {
    const sel = group.selected_category!;
    const key = `${sel.description_category_id}:${sel.type_id}`;
    const entry = pairMap.get(key);
    if (entry) {
      entry.groupIds.push(group.group_id);
    } else {
      pairMap.set(key, { selection: sel, groupIds: [group.group_id] });
    }
  }

  // Step 4: Fetch attributes for each unique pair
  const errors: CommandResult<CategoryInspectResult>['errors'] = [];
  const results: CategoryAttributesGroupResultV1[] = [];

  for (const [, { selection, groupIds }] of pairMap) {
    const attrsResult = await runCategoryAttributes({
      selections: [{
        group_ids: groupIds,
        category: {
          descriptionCategoryId: selection.description_category_id,
          typeId: selection.type_id,
          categoryName: selection.description_category_name,
          typeName: selection.type_name,
          categoryPathZh: selection.category_path_zh,
        },
      }],
    });

    if (!attrsResult.ok) {
      errors.push(...attrsResult.errors);
    } else if (attrsResult.data?.[0]) {
      results.push(attrsResult.data[0]);
    }
  }

  if (errors.length > 0) {
    try {
      await saveCategoryAttributesSnapshot(
        { offerId: sourceOfferId, productsDir },
        results,
        'failed',
      );
    } catch (error) {
      errors.push({
        code: 'PRODUCT_WORKSPACE_WRITE_FAILED',
        message: error instanceof Error ? error.message : String(error),
        recoverable: false,
      });
    }
    return {
      ok: false,
      command: 'workflow.category.inspect',
      data: {
        source: sourceData,
        category_decision: decision,
        category_attributes: results.length > 0 ? results : undefined,
      },
      warnings: [],
      errors,
      nextActions: [],
    };
  }


  try {
    await saveCategoryAttributesSnapshot(
      { offerId: sourceOfferId, productsDir },
      results,
    );
  } catch (error) {
    return productWorkspaceWriteFailure(sourceData, decision, error);
  }

  return {
    ok: true,
    command: 'workflow.category.inspect',
    data: {
      source: sourceData,
      category_decision: decision,
      category_attributes: results,
    },
    warnings: [],
    errors: [],
    nextActions: [],
  };
}

function productWorkspaceWriteFailure(
  source: unknown,
  decision: CategoryDecisionV1,
  error: unknown,
): CommandResult<CategoryInspectResult> {
  return {
    ok: false,
    command: 'workflow.category.inspect',
    data: { source, category_decision: decision },
    warnings: [],
    errors: [
      {
        code: 'PRODUCT_WORKSPACE_WRITE_FAILED',
        message: error instanceof Error ? error.message : String(error),
        recoverable: false,
      },
    ],
    nextActions: [],
  };
}
