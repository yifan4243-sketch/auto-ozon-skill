import type {
  CategoryDecisionV1,
  OzonCategorySelectionV1,
} from '../../contracts/src/category-decision.js';
import type { CanonicalProductV2 } from '../../contracts/src/canonical-product-v2.js';
import {
  validateOzonCategoryPair,
  type OzonCategoryRecord,
} from './ozon-category-tree.js';

export interface CategoryDecisionViolation {
  code: string;
  message: string;
  sku_ids: string[];
}

export interface CategoryDecisionValidationResult {
  status: 'pass' | 'fail';
  valid: boolean;
  violations: CategoryDecisionViolation[];
}

export function validateCategoryDecision(
  decision: CategoryDecisionV1,
  product: CanonicalProductV2,
  categoryIndex: readonly OzonCategoryRecord[],
): CategoryDecisionValidationResult {
  const violations: CategoryDecisionViolation[] = [];
  const sourceSkuIds = product.skus.map((sku) => sku.source_sku_id);
  const sourceSkuSet = new Set(sourceSkuIds);
  const assigned = new Map<string, string>();
  const groupIds = new Set<string>();

  if (decision.source_offer_id !== product.source.offer_id) {
    add('SOURCE_OFFER_ID_MISMATCH', 'Decision offer ID does not match the source product.');
  }
  if (product.validation.status === 'blocked' && decision.status !== 'blocked') {
    add('BLOCKED_SOURCE_PRODUCT', 'A blocked source product requires a blocked category decision.');
  }
  if (decision.errors.length > 0 && decision.status !== 'blocked') {
    add('ERRORS_REQUIRE_BLOCKED', 'A decision containing errors must be blocked.');
  }

  for (const group of decision.category_groups) {
    if (!group.group_id.trim() || groupIds.has(group.group_id)) {
      add('INVALID_GROUP_ID', `Category group ID is empty or duplicated: ${group.group_id}`);
    }
    groupIds.add(group.group_id);
    if (group.source_sku_ids.length === 0) {
      add('EMPTY_CATEGORY_GROUP', `Category group ${group.group_id} has no SKUs.`);
    }
    for (const skuId of group.source_sku_ids) {
      if (!sourceSkuSet.has(skuId)) {
        add('UNKNOWN_SKU_ID', `Category group contains unknown SKU ID: ${skuId}`, [skuId]);
      } else if (assigned.has(skuId)) {
        add(
          'DUPLICATE_SKU_ASSIGNMENT',
          `SKU ${skuId} is assigned to multiple groups.`,
          [skuId],
        );
      } else {
        assigned.set(skuId, group.group_id);
      }
    }
    if (!group.selected_category) {
      if (decision.status === 'decided') {
        add(
          'DECIDED_GROUP_WITHOUT_CATEGORY',
          `Decided group ${group.group_id} has no selected category.`,
          group.source_sku_ids,
        );
      }
    } else {
      validateCategorySnapshot(group.selected_category, group.source_sku_ids);
    }
    for (const alternative of group.alternative_categories) {
      validateCategorySnapshot(alternative, group.source_sku_ids);
    }
  }

  const unassignedSeen = new Set<string>();
  for (const skuId of decision.unassigned_sku_ids) {
    if (!sourceSkuSet.has(skuId)) {
      add('UNKNOWN_UNASSIGNED_SKU_ID', `Unassigned list contains unknown SKU ID: ${skuId}`, [skuId]);
    }
    if (unassignedSeen.has(skuId) || assigned.has(skuId)) {
      add('DUPLICATE_SKU_COVERAGE', `SKU ${skuId} is covered more than once.`, [skuId]);
    }
    unassignedSeen.add(skuId);
  }
  const missing = sourceSkuIds.filter(
    (skuId) => !assigned.has(skuId) && !unassignedSeen.has(skuId),
  );
  if (missing.length > 0) {
    add('MISSING_SKU_COVERAGE', 'Some source SKUs are absent from the decision.', missing);
  }
  if (decision.unassigned_sku_ids.length > 0 && decision.status !== 'blocked') {
    add('UNASSIGNED_SKUS_REQUIRE_BLOCKED', 'Unassigned SKUs require a blocked decision.', decision.unassigned_sku_ids);
  }

  const representativeSet = new Set<string>();
  for (const skuId of decision.representative_sku_ids) {
    if (!sourceSkuSet.has(skuId)) {
      add('UNKNOWN_REPRESENTATIVE_SKU', `Representative SKU does not exist: ${skuId}`, [skuId]);
    }
    if (representativeSet.has(skuId)) {
      add('DUPLICATE_REPRESENTATIVE_SKU', `Representative SKU is duplicated: ${skuId}`, [skuId]);
    }
    representativeSet.add(skuId);
  }
  if (decision.representative_sku_ids.length === 0) {
    add('MISSING_REPRESENTATIVE_SKU', 'At least one representative SKU is required.');
  }

  if (decision.product_structure === 'normal_variants' && decision.category_groups.length !== 1) {
    add('NORMAL_VARIANTS_GROUP_COUNT', 'Normal variants must use exactly one category group.');
  }
  if (decision.product_structure === 'mixed_product' && decision.category_groups.length < 2) {
    add('MIXED_PRODUCT_GROUP_COUNT', 'A mixed product must contain at least two category groups.');
  }
  if (decision.product_structure === 'unclear' && decision.status === 'decided') {
    add('UNCLEAR_PRODUCT_DECIDED', 'An unclear product structure cannot be decided.');
  }

  return {
    status: violations.length === 0 ? 'pass' : 'fail',
    valid: violations.length === 0,
    violations,
  };

  function validateCategorySnapshot(
    selection: OzonCategorySelectionV1,
    skuIds: string[],
  ): void {
    const validation = validateOzonCategoryPair(
      categoryIndex,
      selection.description_category_id,
      selection.type_id,
    );
    if (!validation.valid || !validation.category) {
      add(validation.code, validation.message, skuIds);
      return;
    }
    const expected = validation.category;
    if (
      selection.description_category_name !== expected.description_category_name ||
      selection.type_name !== expected.type_name ||
      JSON.stringify(selection.category_path_zh) !== JSON.stringify(expected.category_path_zh)
    ) {
      add(
        'CATEGORY_SNAPSHOT_MISMATCH',
        `Category names or path do not match ${selection.description_category_id}/${selection.type_id}.`,
        skuIds,
      );
    }
  }

  function add(code: string, message: string, skuIds: string[] = []): void {
    violations.push({ code, message, sku_ids: skuIds });
  }
}
