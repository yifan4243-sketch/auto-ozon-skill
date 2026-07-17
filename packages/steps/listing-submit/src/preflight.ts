import { createHash } from 'node:crypto';
import type { AttributeMappingV1, CategoryAttributesGroupV1, CostPricingV1, ListingDraftV1, PreflightCheckV1, PreflightReportV1, StoreProfileV2 } from '@auto-ozon/contracts';

export function validatePublishPreflight(input: {
  run_id: string; draft: ListingDraftV1; store: StoreProfileV2;
  pricing?: CostPricingV1 | null; attributes?: AttributeMappingV1 | null;
  category_attributes?: CategoryAttributesGroupV1[] | null; now?: string;
}): PreflightReportV1 {
  const checks: PreflightCheckV1[] = [];
  check(checks, 'DRAFT_STATUS', input.draft.status === 'draft_complete', '草稿必须为 draft_complete。');
  check(checks, 'DRAFT_ITEMS', input.draft.items.length > 0, '草稿必须至少包含一个 SKU。');
  check(checks, 'PUBLISHING_ENABLED', input.store.publishing.enabled, '店铺必须预先启用自动发布。');
  check(checks, 'BATCH_LIMIT', input.draft.items.length <= input.store.publishing.max_items_per_batch, '草稿 SKU 数不能超过店铺单批上限。');
  check(checks, 'CURRENCY', input.draft.items.every((item) => item.currency_code === input.store.currency_code), '草稿币种必须匹配店铺币种。');
  const offerIds = input.draft.items.map((item) => item.offer_id);
  check(checks, 'OFFER_ID_UNIQUE', new Set(offerIds).size === offerIds.length, 'offer_id 必须唯一。', offerIds);
  const allowed = new Set(input.store.publishing.allowed_description_category_ids);
  check(checks, 'CATEGORY_ALLOWLIST', allowed.size === 0 || input.draft.items.every((item) => allowed.has(item.description_category_id)), '类目必须在店铺允许列表中。');
  check(checks, 'PRICE', input.draft.items.every((item) => /^\d+(?:\.\d{1,2})?$/u.test(item.price) && Number(item.price) > 0), '价格必须是正数且最多两位小数。');
  check(checks, 'WEIGHT_DIMENSIONS', input.draft.items.every((item) => item.weight > 3 && item.depth > 0 && item.width > 0 && item.height > 0), '重量和尺寸必须有效。');
  check(checks, 'IMAGES', input.draft.items.every((item) => item.images.length > 0 && item.images.includes(item.primary_image)), '每个 SKU 必须有图片且主图属于图片数组。');
  check(checks, 'ATTRIBUTES', Boolean(input.category_attributes?.length) && input.draft.items.every((item) => invalidAttributeIds(item, input.category_attributes!).length === 0), '当前类目快照中的必填属性和字典值必须完整有效。');
  check(checks, 'CATEGORY_SNAPSHOT_FRESH', Boolean(input.category_attributes?.length) && input.category_attributes!.every((group) => Date.parse(group.attributes_schema.snapshot.valid_to) > Date.parse(input.now ?? new Date().toISOString())), '类目属性快照必须存在且未过期。');
  if (input.pricing) {
    check(checks, 'PRICING_STATUS', input.pricing.status === 'completed', '成本定价必须完成。');
    check(checks, 'MINIMUM_MARGIN', input.pricing.sku_pricing.every((sku) => sku.estimated_profit_margin_percent >= Number(input.store.pricing.minimum_margin_percent)), '预计利润率不能低于店铺底线。');
  } else check(checks, 'PRICING_ARTIFACT', false, '缺少成本定价产物。');
  if (input.attributes) check(checks, 'ATTRIBUTE_MAPPING_STATUS', input.attributes.status === 'completed', '属性填写必须完成。');
  else check(checks, 'ATTRIBUTE_MAPPING_ARTIFACT', false, '缺少属性填写产物。');
  return {
    schema_version: 1, run_id: input.run_id, store_id: input.store.store_id,
    draft_sha256: stableHash(input.draft.items), checked_at: input.now ?? new Date().toISOString(),
    status: checks.some((item) => item.status === 'failed') ? 'blocked' : 'passed', checks,
  };
}

export function stableHash(value: unknown): string { return createHash('sha256').update(stable(value)).digest('hex'); }

function invalidAttributeIds(item: ListingDraftV1['items'][number], groups: CategoryAttributesGroupV1[]): number[] {
  const snapshot = groups.find((group) => group.category.description_category_id === item.description_category_id && group.category.type_id === item.type_id)?.attributes_schema;
  if (!snapshot) return [-1];
  const byId = new Map(item.attributes.map((attribute) => [attribute.id, attribute]));
  const invalid = snapshot.attributes.filter((attribute) => attribute.required && !byId.get(attribute.id)?.values.length).map((attribute) => attribute.id);
  for (const policyId of [4383, 4497, 9048]) if (snapshot.attributes.some((attribute) => attribute.id === policyId) && !byId.get(policyId)?.values.length) invalid.push(policyId);
  for (const [id, output] of byId) {
    const definition = snapshot.attributes.find((attribute) => attribute.id === id);
    if (!definition) { invalid.push(id); continue; }
    if (definition.dictionary_id > 0) {
      const allowed = new Set(definition.values.map((value) => value.id));
      if (output.values.some((value) => !Number.isSafeInteger(value.dictionary_value_id) || !allowed.has(Number(value.dictionary_value_id)))) invalid.push(id);
    }
  }
  return [...new Set(invalid)];
}
function check(checks: PreflightCheckV1[], code: string, passed: boolean, message: string, offerIds: string[] = []): void { checks.push({ code, status: passed ? 'passed' : 'failed', message, offer_ids: offerIds }); }
function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stable(object[key])}`).join(',')}}`;
}
