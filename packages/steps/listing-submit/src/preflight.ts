import { createHash } from 'node:crypto';
import type {
  AttributeMappingV2,
  CanonicalProductV2,
  CategoryAttributesGroupV1,
  CategoryDecisionV1,
  ContentBundleV1,
  CostPricingV1,
  ImageBundleV1,
  ListingDraftV2,
  PreflightCheckV1,
  PreflightReportV1,
  StoreProfileV2,
} from '@auto-ozon/contracts';
import { validateListingDraftArtifact } from '@auto-ozon/step-draft-generation';

export function validatePublishPreflight(input: {
  run_id: string; draft: unknown; store: StoreProfileV2;
  product?: CanonicalProductV2 | null; category_decision?: CategoryDecisionV1 | null;
  pricing?: CostPricingV1 | null; attributes?: AttributeMappingV2 | null;
  category_attributes?: CategoryAttributesGroupV1[] | null; content?: ContentBundleV1 | null;
  images?: ImageBundleV1 | null; daily_succeeded_count?: number;
  pending_item_count?: number; now?: string;
}): PreflightReportV1 {
  const checks: PreflightCheckV1[] = [];
  const draftValidation = validateListingDraftArtifact(input.draft);
  if (!draftValidation.ok) {
    check(checks, 'DRAFT_SCHEMA', false, `${draftValidation.code}: ${draftValidation.errors.join('; ')}`);
    return {
      schema_version: 1,
      run_id: input.run_id,
      store_id: input.store.store_id,
      draft_sha256: stableHash(input.draft),
      checked_at: input.now ?? new Date().toISOString(),
      status: 'blocked',
      checks,
    };
  }
  const draft = draftValidation.value;
  check(checks, 'DRAFT_SCHEMA', true, '发布只接受 ListingDraftV2。');
  check(checks, 'DRAFT_STATUS', draft.status === 'draft_complete', '草稿必须为 draft_complete。');
  check(checks, 'DRAFT_ITEMS', draft.items.length > 0, '草稿必须至少包含一个 SKU。');
  check(checks, 'PUBLISHING_ENABLED', input.store.publishing.enabled, '店铺必须预先启用自动发布。');
  check(checks, 'BATCH_LIMIT', draft.items.length <= input.store.publishing.max_items_per_batch, '草稿 SKU 数不能超过店铺单批上限。');
  check(checks, 'DAILY_LIMIT', (input.daily_succeeded_count ?? 0) + (input.pending_item_count ?? draft.items.length) <= input.store.publishing.daily_listing_limit, '店铺当天成功数量加本批待提交 SKU 数不能超过每日上限。');
  check(checks, 'CURRENCY', draft.items.every((item) => item.currency_code === input.store.currency_code), '草稿币种必须匹配店铺币种。');
  const offerIds = draft.items.map((item) => item.offer_id);
  check(checks, 'OFFER_ID_UNIQUE', new Set(offerIds).size === offerIds.length, 'offer_id 必须唯一。', offerIds);
  const allowed = new Set(input.store.publishing.allowed_description_category_ids);
  check(checks, 'CATEGORY_ALLOWLIST', allowed.size === 0 || draft.items.every((item) => allowed.has(item.description_category_id)), '类目必须在店铺允许列表中。');
  check(checks, 'PRICE', draft.items.every((item) => /^\d+(?:\.\d{1,2})?$/u.test(item.price) && Number(item.price) > 0), '价格必须是正数且最多两位小数。');
  check(checks, 'WEIGHT_DIMENSIONS', draft.items.every((item) => item.weight > 3 && item.depth > 0 && item.width > 0 && item.height > 0), '重量和尺寸必须有效。');
  check(checks, 'IMAGES', draft.items.every((item) => item.images.length > 0 && item.images.includes(item.primary_image)), '每个 SKU 必须有图片且主图属于图片数组。');
  check(checks, 'PRIMARY_IMAGE_FIRST', draft.items.every((item) => item.primary_image === item.images[0]), '每个 SKU 的主图必须是构建完成后的 images[0]。');
  check(checks, 'SKU_BINDINGS', validSkuBindings(draft), '草稿必须保留完整且唯一的 source_sku_id 到 offer_id 绑定。');
  check(checks, 'ATTRIBUTES', Boolean(input.category_attributes?.length) && draft.items.every((item) => invalidAttributeIds(item, input.category_attributes!).length === 0), '当前类目快照中的必填属性和字典值必须完整有效。');
  check(checks, 'CATEGORY_SNAPSHOT_FRESH', Boolean(input.category_attributes?.length) && input.category_attributes!.every((group) => Date.parse(group.attributes_schema.snapshot.valid_to) > Date.parse(input.now ?? new Date().toISOString())), '类目属性快照必须存在且未过期。');
  check(checks, 'CATEGORY_TREE_SNAPSHOT_FRESH', Boolean(draft.category_tree_snapshot) && Date.parse(draft.category_tree_snapshot!.valid_to) > Date.parse(input.now ?? new Date().toISOString()), '类目树快照必须存在且未过期。');
  check(checks, 'CATEGORY_TREE_SNAPSHOT_MATCH', Boolean(input.category_decision?.category_snapshot) && stableHash(input.category_decision!.category_snapshot) === stableHash(draft.category_tree_snapshot), '草稿必须绑定当前类目决定使用的类目树快照。');
  check(checks, 'ATTRIBUTE_SNAPSHOT_BINDINGS', attributeSnapshotsMatch(draft, input.category_attributes), '草稿中的类目属性快照引用必须与当前产物完全一致。');
  check(checks, 'UPSTREAM_ARTIFACT_HASHES', upstreamHashesMatch({ ...input, draft }), '草稿绑定的所有上游产物哈希必须与当前不可变产物一致。');
  check(checks, 'CONTENT_BUNDLE', input.content?.status === 'completed' && skuCoverage(draft, input.content?.sku_content.map((item) => item.source_sku_id)), '俄语 ContentBundle 必须完成并覆盖全部 SKU。');
  check(checks, 'IMAGE_BUNDLE', input.images?.status === 'completed' && skuCoverage(draft, input.images?.sku_images.map((item) => item.source_sku_id)), 'ImageBundle 必须完成并覆盖全部 SKU。');
  if (input.pricing) {
    check(checks, 'PRICING_STATUS', input.pricing.status === 'completed', '成本定价必须完成。');
    check(checks, 'MINIMUM_MARGIN', input.pricing.sku_pricing.every((sku) => sku.estimated_profit_margin_percent >= Number(input.store.pricing.minimum_margin_percent)), '预计利润率不能低于店铺底线。');
  } else check(checks, 'PRICING_ARTIFACT', false, '缺少成本定价产物。');
  if (input.attributes) check(checks, 'ATTRIBUTE_MAPPING_STATUS', input.attributes.status === 'completed', '属性填写必须完成。');
  else check(checks, 'ATTRIBUTE_MAPPING_ARTIFACT', false, '缺少属性填写产物。');
  return {
    schema_version: 1, run_id: input.run_id, store_id: input.store.store_id,
    draft_sha256: stableHash(draft.items), checked_at: input.now ?? new Date().toISOString(),
    status: checks.some((item) => item.status === 'failed') ? 'blocked' : 'passed', checks,
  };
}

export function stableHash(value: unknown): string { return createHash('sha256').update(stable(value)).digest('hex'); }

function invalidAttributeIds(item: ListingDraftV2['items'][number], groups: CategoryAttributesGroupV1[]): number[] {
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
      const fixedNoBrand = id === 85 && output.values.every((value) => value.dictionary_value_id === 126745801);
      if (!fixedNoBrand && output.values.some((value) => !Number.isSafeInteger(value.dictionary_value_id) || !allowed.has(Number(value.dictionary_value_id)))) invalid.push(id);
    }
  }
  return [...new Set(invalid)];
}

function validSkuBindings(draft: ListingDraftV2): boolean {
  const sourceIds = draft.sku_bindings.map((item) => item.source_sku_id);
  const offerIds = draft.sku_bindings.map((item) => item.offer_id);
  const itemOfferIds = new Set(draft.items.map((item) => item.offer_id));
  return draft.sku_bindings.length === draft.items.length
    && new Set(sourceIds).size === sourceIds.length
    && new Set(offerIds).size === offerIds.length
    && offerIds.every((offerId) => itemOfferIds.has(offerId));
}

function skuCoverage(draft: ListingDraftV2, actual: string[] | undefined): boolean {
  if (!actual) return false;
  const expected = draft.sku_bindings.map((item) => item.source_sku_id).sort();
  return stableHash(expected) === stableHash([...actual].sort());
}

function attributeSnapshotsMatch(draft: ListingDraftV2, groups: CategoryAttributesGroupV1[] | null | undefined): boolean {
  if (!groups) return false;
  const current = groups.map((group) => ({
    group_ids: [...group.group_ids],
    description_category_id: group.category.description_category_id,
    type_id: group.category.type_id,
    captured_at: group.attributes_schema.snapshot.captured_at,
    valid_from: group.attributes_schema.snapshot.valid_from,
    valid_to: group.attributes_schema.snapshot.valid_to,
    sha256: group.attributes_schema.snapshot.sha256,
  }));
  return stableHash(current) === stableHash(draft.attribute_snapshot_refs);
}

function upstreamHashesMatch(input: Parameters<typeof validatePublishPreflight>[0] & { draft: ListingDraftV2 }): boolean {
  if (!input.product || !input.category_decision || !input.pricing || !input.category_attributes
    || !input.attributes || !input.content || !input.images) return false;
  const expected = {
    canonical_product_sha256: stableHash(input.product),
    category_decision_sha256: stableHash(input.category_decision),
    cost_pricing_sha256: stableHash(input.pricing),
    category_attributes_sha256: stableHash(input.category_attributes),
    attribute_mapping_sha256: stableHash(input.attributes),
    content_bundle_sha256: stableHash(input.content),
    image_bundle_sha256: stableHash(input.images),
  };
  return stableHash(expected) === stableHash(input.draft.artifact_hashes);
}
function check(checks: PreflightCheckV1[], code: string, passed: boolean, message: string, offerIds: string[] = []): void { checks.push({ code, status: passed ? 'passed' : 'failed', message, offer_ids: offerIds }); }
function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stable(object[key])}`).join(',')}}`;
}
