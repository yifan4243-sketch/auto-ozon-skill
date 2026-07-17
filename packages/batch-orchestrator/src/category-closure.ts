import type { CategoryClosureV1, CategoryDecisionV1, SelectedMarketCategoryV1 } from '@auto-ozon/contracts';

export function validateCategoryClosure(
  selected: SelectedMarketCategoryV1 | null,
  decision: CategoryDecisionV1,
  agentJustification?: { rationale_zh: string; confidence: 'high' | 'medium' | 'low' },
): CategoryClosureV1[] {
  return decision.category_groups.map((group) => {
    if (!group.selected_category) throw new Error('CATEGORY_CLOSURE_MISSING_SELECTED_CATEGORY');
    const ozon = group.selected_category;
    const analyticsId = selected?.analytics_category_id ?? null;
    const exact = analyticsId !== null && analyticsId === ozon.description_category_id;
    const family = selected ? pathTokens(selected.category_path_zh).some((token) => pathTokens(ozon.category_path_zh.join(' > ')).includes(token)) : true;
    const relation: CategoryClosureV1['relation'] = exact ? 'exact' : family ? 'same_path_family'
      : agentJustification ? 'agent_justified_deviation' : 'unrelated';
    const confidence = exact ? 'high' : relation === 'same_path_family' ? group.confidence : agentJustification?.confidence ?? 'low';
    const status = relation === 'unrelated' ? 'blocked' : confidence === 'low' ? 'needs_review' : 'accepted';
    return {
      schema_version: 1, analytics_category_id: analyticsId,
      selected_description_category_id: ozon.description_category_id, selected_type_id: ozon.type_id,
      relation, confidence, rationale_zh: exact ? '市场分析类目与最终 Ozon description_category_id 完全一致。'
        : relation === 'same_path_family' ? '市场分析类目与最终 Ozon 类目属于同一路径家族。'
          : agentJustification?.rationale_zh ?? '市场分析类目与最终 Ozon 类目缺少可验证关系。',
      status,
    };
  });
}

function pathTokens(value: string): string[] {
  return value.split(/[>\/|—–-]/u).map((token) => token.trim().toLocaleLowerCase()).filter((token) => token.length >= 2);
}
