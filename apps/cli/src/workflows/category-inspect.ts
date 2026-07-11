import { search1688ByKeywordV2 } from '../../../../packages/adapters-1688/src/client.js';
import { getCategoryAttributes } from '../../../../packages/adapters-ozon/src/category/category-attributes.js';
import type { CategoryDecisionV1, OzonCategorySelectionV1 } from '../../../../packages/contracts/src/category-decision.js';
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
  category_attributes?: CategoryAttributesV1[];
}

interface CategoryPairKey {
  description_category_id: number;
  type_id: number;
}

function pairKey(cat: OzonCategorySelectionV1): string {
  return `${cat.description_category_id}:${cat.type_id}`;
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

  if (!provider) {
    return {
      ok: true,
      command: 'workflow.category.inspect',
      data: { source: sourceData },
      warnings: [
        {
          code: 'NO_DECISION_PROVIDER',
          message:
            'No --decision-file or decision provider supplied. Provide --decision-file to complete the pipeline.',
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

  // Validate decision matches source product
  const srcAny = sourceData as unknown as { items?: Array<{ source?: { offer_id?: string } }> };
  const sourceOfferId = srcAny?.items?.[0]?.source?.offer_id;
  if (sourceOfferId && decision.source_offer_id && decision.source_offer_id !== sourceOfferId) {
    return {
      ok: false,
      command: 'workflow.category.inspect',
      data: { source: sourceData, category_decision: decision },
      warnings: [],
      errors: [
        {
          code: 'DECISION_OFFER_ID_MISMATCH',
          message: `Decision offer_id (${decision.source_offer_id}) does not match sourced product (${sourceOfferId}).`,
          recoverable: true,
        },
      ],
      nextActions: ['Ensure the --decision-file corresponds to the currently sourced product.'],
    };
  }

  // Validate SKU coverage
  const srcItem = srcAny?.items?.[0];
  const sourceSkus = (srcItem as unknown as { skus?: Array<{ source_sku_id: string }> })?.skus;
  if (sourceSkus) {
    const sourceSkuIds = new Set(sourceSkus.map((s) => s.source_sku_id));
    const decisionSkuIds = new Set<string>();
    for (const group of decision.category_groups) {
      for (const skuId of group.source_sku_ids) decisionSkuIds.add(skuId);
    }
    for (const skuId of decision.unassigned_sku_ids) decisionSkuIds.add(skuId);

    const unknownSkus = [...decisionSkuIds].filter((id) => !sourceSkuIds.has(id));
    if (unknownSkus.length > 0) {
      return {
        ok: false,
        command: 'workflow.category.inspect',
        data: { source: sourceData, category_decision: decision },
        warnings: [],
        errors: [
          {
            code: 'DECISION_SKU_MISMATCH',
            message: `Decision references ${unknownSkus.length} SKU IDs not present in the sourced product (first 5: ${unknownSkus.slice(0, 5).join(', ')})`,
            recoverable: true,
          },
        ],
        nextActions: [],
      };
    }
  }

  // Step 3: Collect all unique category pairs from all groups
  const decidedGroups = decision.category_groups.filter(
    (g) => g.selected_category !== null,
  );

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

  // Deduplicate by (description_category_id, type_id)
  const uniquePairs = new Map<string, { selection: OzonCategorySelectionV1; groupId: string }>();
  for (const group of decidedGroups) {
    const sel = group.selected_category!;
    const key = pairKey(sel);
    if (!uniquePairs.has(key)) {
      uniquePairs.set(key, { selection: sel, groupId: group.group_id });
    }
  }

  // Step 4: Fetch category attributes for each unique pair
  const allErrors: CommandResult<CategoryInspectResult>['errors'] = [];
  const categoryAttributesResults: CategoryAttributesV1[] = [];

  for (const [, { selection, groupId }] of uniquePairs) {
    const attrsResult = await getCategoryAttributes({
      descriptionCategoryId: selection.description_category_id,
      typeId: selection.type_id,
      categoryName: selection.description_category_name,
      typeName: selection.type_name,
      categoryPathZh: selection.category_path_zh,
      groupId,
    });

    if (!attrsResult.ok) {
      allErrors.push(...attrsResult.errors);
    } else if (attrsResult.data) {
      categoryAttributesResults.push(attrsResult.data);
    }
  }

  if (allErrors.length > 0 && categoryAttributesResults.length === 0) {
    return {
      ok: false,
      command: 'workflow.category.inspect',
      data: {
        source: sourceData,
        category_decision: decision,
      },
      warnings: [],
      errors: allErrors,
      nextActions: [],
    };
  }

  const hasErrors = allErrors.length > 0;

  return {
    ok: !hasErrors,
    command: 'workflow.category.inspect',
    data: {
      source: sourceData,
      category_decision: decision,
      category_attributes: categoryAttributesResults,
    },
    warnings: hasErrors
      ? allErrors.map((e) => ({
          code: `PARTIAL_${e.code}`,
          message: e.message,
        }))
      : [],
    errors: hasErrors ? allErrors : [],
    nextActions: [],
  };
}
