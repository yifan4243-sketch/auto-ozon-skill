import type {
  CategoryAttributesGroupV1,
  CategoryGroupDecisionV1,
} from '@auto-ozon/contracts';

export function resolveGroupAttributeSnapshot(
  group: CategoryGroupDecisionV1,
  snapshots: CategoryAttributesGroupV1[],
): CategoryAttributesGroupV1 | null {
  const selected = group.selected_category;
  if (!selected) return null;
  const matches = snapshots.filter((snapshot) => snapshot.group_ids.includes(group.group_id));
  if (matches.length !== 1) return null;
  const snapshot = matches[0]!;
  return snapshot.attributes_schema.ok &&
    snapshot.attributes_schema.category.description_category_id === selected.description_category_id &&
    snapshot.attributes_schema.category.type_id === selected.type_id
    ? snapshot
    : null;
}
