import { createHash } from 'node:crypto';
import type {
  AttributeMappingV1,
  CanonicalProductV2,
  CategoryAttributesGroupV1,
  CategoryDecisionV1,
  CommandResult,
  CostPricingV1,
  DraftGenerationProfileV1,
  ListingDraftIssueV1,
  ListingDraftItemV1,
  ListingDraftV1,
  OzonReadyAttributeV1,
} from '@auto-ozon/contracts';
import { assertWorkflowActive, type WorkflowContext } from '@auto-ozon/artifact-store';
import { validateListingDraftSchema } from './schema-validator.js';

export interface RunDraftGenerationInput {
  product: CanonicalProductV2;
  category_decision: CategoryDecisionV1;
  category_attributes: CategoryAttributesGroupV1[];
  cost_pricing: CostPricingV1;
  attribute_mapping: AttributeMappingV1;
  profile?: DraftGenerationProfileV1;
}

export async function runDraftGeneration(
  input: RunDraftGenerationInput,
  context?: WorkflowContext,
): Promise<CommandResult<ListingDraftV1>> {
  try {
    if (context) {
      assertWorkflowActive(context);
      await context.artifact_store.updateStep(context.run_id, 'draft-generation', { status: 'running' });
    }
    const draft = buildDraft(input);
    const schema = validateListingDraftSchema(draft);
    if (!schema.valid) {
      draft.errors.push(issue('LISTING_DRAFT_SCHEMA_INVALID', schema.errors.join('; ')));
    }
    if (draft.errors.length > 0) draft.status = 'blocked';
    if (context) {
      const output = await context.artifact_store.write(
        context.run_id, 'draft-generation', 'listing-draft-v1.json', draft,
      );
      await context.artifact_store.updateStep(context.run_id, 'draft-generation', {
        status: draft.status === 'draft_complete' ? 'succeeded' : draft.status,
        output,
      });
    }
    return {
      ok: draft.status !== 'blocked', command: 'draft.generation', data: draft,
      warnings: draft.warnings.map((value) => ({ code: value.code, message: value.message, detail: value })),
      errors: draft.errors.map((value) => ({ code: value.code, message: value.message, detail: value, recoverable: true })),
      nextActions: draft.status === 'blocked' ? ['Fix the reported upstream product, pricing, image, or attribute data and rerun draft-generation.'] : [],
    };
  } catch (error) {
    if (context) await context.artifact_store.updateStep(context.run_id, 'draft-generation', { status: 'failed', error_code: 'DRAFT_GENERATION_FAILED' });
    return { ok: false, command: 'draft.generation', warnings: [], errors: [{ code: 'DRAFT_GENERATION_FAILED', message: error instanceof Error ? error.message : String(error), recoverable: true }], nextActions: [] };
  }
}

function buildDraft(input: RunDraftGenerationInput): ListingDraftV1 {
  const result: ListingDraftV1 = {
    schema_version: 1, source_offer_id: input.product.source.offer_id, status: 'draft_complete', items: [], warnings: [], errors: [],
  };
  if (input.attribute_mapping.status === 'blocked' || input.cost_pricing.status !== 'completed' || input.category_decision.status === 'blocked') {
    result.errors.push(issue('BLOCKED_UPSTREAM', 'Draft generation requires completed pricing and non-blocked category and attribute mapping.'));
    return result;
  }
  if (input.attribute_mapping.source_offer_id !== input.product.source.offer_id || input.cost_pricing.source_offer_id !== input.product.source.offer_id) {
    result.errors.push(issue('OFFER_ID_MISMATCH', 'Upstream artifacts belong to different source offers.'));
    return result;
  }
  for (const sku of input.product.skus) {
    const mapped = input.attribute_mapping.sku_attributes.find((value) => value.source_sku_id === sku.source_sku_id);
    const priced = input.cost_pricing.sku_pricing.find((value) => value.source_sku_id === sku.source_sku_id);
    if (!mapped || !priced) {
      result.errors.push(issue('SKU_UPSTREAM_MISSING', `SKU ${sku.source_sku_id} is missing mapping or pricing.`, [sku.source_sku_id]));
      continue;
    }
    const category = input.category_attributes.find((value) => value.group_ids.includes(mapped.group_id));
    if (!category || category.category.description_category_id !== mapped.description_category_id || category.category.type_id !== mapped.type_id) {
      result.errors.push(issue('CATEGORY_SNAPSHOT_MISMATCH', `SKU ${sku.source_sku_id} does not match its current category snapshot.`, [sku.source_sku_id]));
      continue;
    }
    const item = buildItem(sku.source_sku_id, sku.image, input.product, mapped.ozon_attributes, mapped.description_category_id, mapped.type_id, priced, input.profile, result);
    if (!item) continue;
    validateAttributes(item, sku.source_sku_id, category, result);
    result.items.push(item);
  }
  if (result.items.length !== input.product.skus.length) result.errors.push(issue('SKU_COVERAGE_INCOMPLETE', 'Draft does not contain every canonical SKU.'));
  validate9048(input.category_attributes, input.attribute_mapping, result);
  if (input.attribute_mapping.status === 'needs_review' && result.errors.length === 0) {
    result.status = 'needs_review';
    result.warnings.push(issue('UPSTREAM_MAPPING_NEEDS_REVIEW', 'Draft preserves an upstream attribute-mapping review warning.'));
  }
  return result;
}

function buildItem(
  sourceSkuId: string, skuImage: string | null | undefined, product: CanonicalProductV2, attributes: OzonReadyAttributeV1[], categoryId: number, typeId: number,
  priced: CostPricingV1['sku_pricing'][number], profile: DraftGenerationProfileV1 | undefined, result: ListingDraftV1,
): ListingDraftItemV1 | null {
  const title = attributeText(attributes, 4180);
  if (!title) { result.errors.push(issue('TITLE_4180_MISSING', `SKU ${sourceSkuId} lacks attribute 4180.`, [sourceSkuId], [4180])); return null; }
  const images = buildImages([skuImage, product.product.main_image, ...product.product.gallery_images]);
  if (images.length === 0) { result.errors.push(issue('IMAGES_MISSING', `SKU ${sourceSkuId} has no valid source image.`, [sourceSkuId])); return null; }
  const weight = Math.ceil(priced.package.actual_weight_g);
  const dimensions = [priced.package.length_cm, priced.package.width_cm, priced.package.height_cm].map((value) => Math.ceil(value * 10));
  if (!Number.isFinite(weight) || weight <= 0 || dimensions.some((value) => !Number.isFinite(value) || value <= 0)) {
    result.errors.push(issue('PACKAGE_DIMENSIONS_INVALID', `SKU ${sourceSkuId} has invalid priced package dimensions.`, [sourceSkuId])); return null;
  }
  if (!Number.isFinite(priced.final_price_cny) || priced.final_price_cny <= 0) {
    result.errors.push(issue('PRICE_INVALID', `SKU ${sourceSkuId} has no positive final CNY price.`, [sourceSkuId])); return null;
  }
  // attributes are cloned without semantic conversion; 4191 deliberately stays in this array.
  const copiedAttributes = structuredClone(attributes);
  return {
    offer_id: stableOfferId(product.source.offer_id, sourceSkuId), name: title, price: priced.final_price_cny.toFixed(2),
    description_category_id: categoryId, type_id: typeId, weight, depth: dimensions[0]!, width: dimensions[1]!, height: dimensions[2]!,
    dimension_unit: 'mm', weight_unit: 'g', images, primary_image: images[0]!, attributes: copiedAttributes,
    complex_attributes: [], currency_code: profile?.currency_code ?? 'CNY',
  };
}

function buildImages(candidates: Array<string | null | undefined>): string[] {
  const result: string[] = [];
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (!value || result.includes(value)) continue;
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol)) continue;
      result.push(value);
    } catch { /* invalid source URLs are omitted; zero valid images blocks the SKU */ }
  }
  return result.slice(0, 15);
}

function validateAttributes(item: ListingDraftItemV1, skuId: string, category: CategoryAttributesGroupV1, result: ListingDraftV1): void {
  if (item.primary_image !== item.images[0] || !item.images.includes(item.primary_image)) result.errors.push(issue('PRIMARY_IMAGE_INVALID', `SKU ${skuId} primary image must be the first built image.`, [skuId]));
  const ids = item.attributes.map((attribute) => attribute.id);
  if (ids.some((id, index) => index > 0 && id < ids[index - 1]!)) result.errors.push(issue('ATTRIBUTES_NOT_SORTED', `SKU ${skuId} attributes must be sorted by ID.`, [skuId]));
  const byId = new Map(category.attributes_schema.attributes.map((attribute) => [attribute.id, attribute]));
  for (const attribute of item.attributes) {
    const schema = byId.get(attribute.id);
    if (!schema) { result.errors.push(issue('ATTRIBUTE_NOT_IN_SNAPSHOT', `Attribute ${attribute.id} is not in the current category snapshot.`, [skuId], [attribute.id])); continue; }
    if (schema.dictionary_id > 0) {
      for (const value of attribute.values) {
        const candidate = schema.values.find((entry) => entry.id === value.dictionary_value_id && entry.value === value.value);
        if (!candidate && attribute.id !== 85) result.errors.push(issue('DICTIONARY_VALUE_INVALID', `Attribute ${attribute.id} has a dictionary value outside the current snapshot.`, [skuId], [attribute.id]));
      }
    }
  }
  if (!attributeText(item.attributes, 4191)) result.errors.push(issue('DESCRIPTION_4191_MISSING', `SKU ${skuId} lacks description attribute 4191.`, [skuId], [4191]));
  if (byId.has(10096)) {
    const color = item.attributes.find((attribute) => attribute.id === 10096);
    const multicolor = byId.get(10096)!.values.find((value) => /多色|многоцвет|multicolor/iu.test(value.value));
    if (!color) result.errors.push(issue('COLOR_10096_MISSING', `SKU ${skuId} must include color attribute 10096.`, [skuId], [10096]));
    if (color && color.values.some((value) => value.dictionary_value_id === undefined)) result.errors.push(issue('COLOR_10096_DICTIONARY_ID_REQUIRED', `SKU ${skuId} color must use a real dictionary_value_id.`, [skuId], [10096]));
    // If the mapping selected the policy fallback, it must point to a real “multicolor” candidate.
    if (color && !multicolor && color.values.some((value) => /多色|многоцвет|multicolor/iu.test(value.value))) result.errors.push(issue('COLOR_MULTICOLOR_CANDIDATE_MISSING', `SKU ${skuId} selected multicolor but the snapshot has no multicolor dictionary candidate.`, [skuId], [10096]));
  }
}

function validate9048(groups: CategoryAttributesGroupV1[], mapping: AttributeMappingV1, result: ListingDraftV1): void {
  const values = new Set<string>();
  for (const mapped of mapping.sku_attributes) {
    const category = groups.find((group) => group.group_ids.includes(mapped.group_id));
    if (!category?.attributes_schema.attributes.some((attribute) => attribute.id === 9048)) continue;
    const value = mapped.ozon_attributes.find((attribute) => attribute.id === 9048)?.values.map((entry) => entry.value).join('|');
    if (!value) result.errors.push(issue('TIMESTAMP_9048_MISSING', `SKU ${mapped.source_sku_id} must include 9048 because its category exposes it.`, [mapped.source_sku_id], [9048]));
    else values.add(value);
  }
  if (values.size > 1) result.warnings.push(issue('TIMESTAMP_9048_INCONSISTENT', '9048 differs across SKUs; preserved as a warning for audit.'));
}

function attributeText(attributes: OzonReadyAttributeV1[], id: number): string | null {
  return attributes.find((attribute) => attribute.id === id)?.values.map((value) => value.value).join(' ').trim() || null;
}

function stableOfferId(offerId: string, skuId: string): string {
  const readable = `1688-${offerId}-${skuId}`.replace(/[^A-Za-z0-9._-]+/g, '-');
  return readable.length <= 50 ? readable : `1688-${createHash('sha256').update(`${offerId}:${skuId}`).digest('hex').slice(0, 40)}`;
}

function issue(code: string, message: string, sku_ids: string[] = [], attribute_ids: number[] = []): ListingDraftIssueV1 {
  return { code, message, sku_ids, attribute_ids };
}
