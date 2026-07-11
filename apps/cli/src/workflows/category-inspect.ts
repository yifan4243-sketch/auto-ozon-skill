import { search1688ByKeywordV2 } from '../../../../packages/adapters-1688/src/client.js';
import { getCategoryAttributes } from '../../../../packages/adapters-ozon/src/category/category-attributes.js';
import type { CategoryDecisionV1 } from '../../../../packages/contracts/src/category-decision.js';
import type { CategoryAttributesV1 } from '../../../../packages/contracts/src/category-attributes.js';
import type { CommandResult } from '../../../../packages/contracts/src/command-result.js';
import type { CategoryDecisionProvider } from './category-decision-provider.js';
import { FileDecisionProvider } from './category-decision-provider.js';

export interface CategoryInspectOptions {
  keyword: string;
  max: number;
  decisionFile?: string;
  decisionProvider?: CategoryDecisionProvider;
  json?: boolean;
  pretty?: boolean;
}

export interface CategoryInspectResult {
  source: unknown;
  category_decision?: CategoryDecisionV1;
  category_attributes?: unknown;
}

export async function runCategoryInspect(
  options: CategoryInspectOptions,
): Promise<CommandResult<CategoryInspectResult>> {
  // Step 1: 1688 sourcing → CanonicalProductV2
  const sourceResult = await search1688ByKeywordV2({
    keyword: options.keyword,
    max: options.max,
    sort: 'relevance',
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

  // If no decision provider, return source only
  if (!provider) {
    return {
      ok: true,
      command: 'workflow.category.inspect',
      data: { source: sourceData },
      warnings: [
        {
          code: 'NO_DECISION_PROVIDER',
          message:
            'No --decision-file or decision provider supplied. Category attributes were not fetched. Provide --decision-file to complete the pipeline.',
        },
      ],
      errors: [],
      nextActions: [
        'Run the CategoryDecision Agent on the source CanonicalProductV2 output.',
        'Save the decision as a JSON file and re-run with --decision-file <path>.',
      ],
    };
  }

  // Step 2: Load CategoryDecisionV1
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

  // Step 3: Extract first decided category
  const decidedGroup = decision.category_groups.find(
    (g) => g.selected_category !== null,
  );
  if (!decidedGroup?.selected_category) {
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

  const sel = decidedGroup.selected_category;

  // Step 4: Fetch category attributes via MCP
  const attrsResult = await getCategoryAttributes({
    descriptionCategoryId: sel.description_category_id,
    typeId: sel.type_id,
    categoryName: sel.description_category_name,
    typeName: sel.type_name,
    categoryPathZh: sel.category_path_zh,
  });

  if (!attrsResult.ok) {
    return {
      ok: false,
      command: 'workflow.category.inspect',
      data: {
        source: sourceData,
        category_decision: decision,
      },
      warnings: [],
      errors: attrsResult.errors,
      nextActions: [],
    };
  }

  return {
    ok: true,
    command: 'workflow.category.inspect',
    data: {
      source: sourceData,
      category_decision: decision,
      category_attributes: attrsResult.data,
    },
    warnings: [],
    errors: [],
    nextActions: [],
  };
}
