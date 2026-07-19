import { createHash } from 'node:crypto';
import type {
  AttributeMappingV2,
  CanonicalProductV2,
  CategoryAttributesGroupV1,
  CategoryDecisionV1,
  CommandResult,
  ContentBundleV1,
  CostPricingV1,
  DraftGenerationProfileV1,
  ListingDraftIssueV1,
  ListingDraftItemV2,
  ListingDraftV2,
  ImageBundleV1,
  OzonReadyAttributeV1,
} from '@auto-ozon/contracts';
import { hasForbiddenOzonDescriptionCharacters } from '@auto-ozon/contracts';
import { LEGACY_WEIGHT_SEMANTICS_V1 } from '@auto-ozon/contracts';
import { assertWorkflowActive, type WorkflowContext } from '@auto-ozon/artifact-store';
import { validateListingDraftSchema } from './schema-validator.js';

export interface RunDraftGenerationInput {
  product: CanonicalProductV2;
  category_decision: CategoryDecisionV1;
  category_attributes: CategoryAttributesGroupV1[];
  cost_pricing: CostPricingV1;
  attribute_mapping: AttributeMappingV2;
  content_bundle: ContentBundleV1;
  profile?: DraftGenerationProfileV1;
  image_bundle?: ImageBundleV1;
}

export async function runDraftGeneration(
  input: RunDraftGenerationInput,
  context?: WorkflowContext,
): Promise<CommandResult<ListingDraftV2>> {
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
        context.run_id, 'draft-generation', 'listing-draft-v2.json', draft,
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

function buildDraft(input: RunDraftGenerationInput): ListingDraftV2 {
  const result: ListingDraftV2 = {
    schema_version: 2, source_offer_id: input.product.source.offer_id, status: 'draft_complete', generated_at: new Date().toISOString(), weight_semantics: LEGACY_WEIGHT_SEMANTICS_V1,
    artifact_hashes: {
      canonical_product_sha256: stableHash(input.product),
      category_decision_sha256: stableHash(input.category_decision),
      cost_pricing_sha256: stableHash(input.cost_pricing),
      category_attributes_sha256: stableHash(input.category_attributes),
      attribute_mapping_sha256: stableHash(input.attribute_mapping),
      content_bundle_sha256: stableHash(input.content_bundle),
      image_bundle_sha256: stableHash(input.image_bundle ?? null),
    },
    category_tree_snapshot: input.category_decision.category_snapshot ?? null,
    attribute_snapshot_refs: input.category_attributes.map((group) => ({
      group_ids: [...group.group_ids],
      description_category_id: group.category.description_category_id,
      type_id: group.category.type_id,
      captured_at: group.attributes_schema.snapshot.captured_at,
      valid_from: group.attributes_schema.snapshot.valid_from,
      valid_to: group.attributes_schema.snapshot.valid_to,
      sha256: group.attributes_schema.snapshot.sha256,
    })),
    sku_bindings: [],
    items: [], warnings: [], errors: [],
  };
  if (!result.category_tree_snapshot) {
    result.errors.push(issue('CATEGORY_TREE_SNAPSHOT_MISSING', 'CategoryDecisionV1 must bind the current Ozon category-tree snapshot.'));
    return result;
  }
  if (input.content_bundle.source_offer_id !== input.product.source.offer_id || input.content_bundle.status !== 'completed') {
    result.errors.push(issue('CONTENT_BUNDLE_INVALID', 'ContentBundle must be completed and belong to the current source offer.'));
    return result;
  }
  if (input.image_bundle && (input.image_bundle.source_offer_id !== input.product.source.offer_id || input.image_bundle.status !== 'completed')) {
    result.errors.push(issue('IMAGE_BUNDLE_INVALID', 'ImageBundle must be completed and belong to the current source offer.'));
    return result;
  }
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
    const content = input.content_bundle.sku_content.find((value) => value.source_sku_id === sku.source_sku_id);
    if (!mapped || !priced || !content) {
      result.errors.push(issue('SKU_UPSTREAM_MISSING', `SKU ${sku.source_sku_id} is missing mapping, pricing, or validated content.`, [sku.source_sku_id]));
      continue;
    }
    const category = input.category_attributes.find((value) => value.group_ids.includes(mapped.group_id));
    if (!category || category.category.description_category_id !== mapped.description_category_id || category.category.type_id !== mapped.type_id) {
      result.errors.push(issue('CATEGORY_SNAPSHOT_MISMATCH', `SKU ${sku.source_sku_id} does not match its current category snapshot.`, [sku.source_sku_id]));
      continue;
    }
    const bundledImages = input.image_bundle?.sku_images.find((value) => value.source_sku_id === sku.source_sku_id);
    const item = buildItem(sku.source_sku_id, sku.image, input.product, mapped.ozon_attributes, mapped.description_category_id, mapped.type_id, priced, input.profile, result, bundledImages);
    if (!item) continue;
    if (item.name !== content.title_ru || attributeText(item.attributes, 4191) !== content.description_ru) {
      result.errors.push(issue('CONTENT_BUNDLE_MISMATCH', `SKU ${sku.source_sku_id} draft content differs from ContentBundleV1.`, [sku.source_sku_id], [4180, 4191]));
      continue;
    }
    validateAttributes(item, sku.source_sku_id, category, priced.weight_facts, result);
    result.sku_bindings.push({ source_sku_id: sku.source_sku_id, offer_id: item.offer_id });
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
  priced: CostPricingV1['sku_pricing'][number], profile: DraftGenerationProfileV1 | undefined, result: ListingDraftV2,
  bundledImages?: ImageBundleV1['sku_images'][number],
): ListingDraftItemV2 | null {
  const title = attributeText(attributes, 4180);
  if (!title) { result.errors.push(issue('TITLE_4180_MISSING', `SKU ${sourceSkuId} lacks attribute 4180.`, [sourceSkuId], [4180])); return null; }
  const images = bundledImages
    ? buildImages(bundledImages.images)
    : buildImages([skuImage, product.product.main_image, ...product.product.gallery_images]);
  if (images.length === 0) { result.errors.push(issue('IMAGES_MISSING', `SKU ${sourceSkuId} has no valid source image.`, [sourceSkuId])); return null; }
  const weight = Math.ceil(priced.weight_facts?.draft_weight_g ?? priced.package.actual_weight_g);
  const dimensions = [priced.package.length_cm, priced.package.width_cm, priced.package.height_cm].map((value) => Math.ceil(value * 10));
  if (!Number.isFinite(weight) || weight <= 0 || dimensions.some((value) => !Number.isFinite(value) || value <= 0)) {
    result.errors.push(issue('PACKAGE_DIMENSIONS_INVALID', `SKU ${sourceSkuId} has invalid priced package dimensions.`, [sourceSkuId])); return null;
  }
  if (!Number.isFinite(priced.final_price_cny) || priced.final_price_cny <= 0) {
    result.errors.push(issue('PRICE_INVALID', `SKU ${sourceSkuId} has no positive final CNY price.`, [sourceSkuId])); return null;
  }
  // attributes are cloned without semantic conversion; 4191 deliberately stays in this array.
  const copiedAttributes = structuredClone(attributes);
  const bundledPrimaryImage = bundledImages?.primary_image;
  return {
    offer_id: stableOfferId(product.source.offer_id, sourceSkuId), name: title, price: priced.final_price_cny.toFixed(2),
    description_category_id: categoryId, type_id: typeId, weight, depth: dimensions[0]!, width: dimensions[1]!, height: dimensions[2]!,
    dimension_unit: 'mm', weight_unit: 'g', images,
    primary_image: bundledPrimaryImage && bundledPrimaryImage === images[0] ? bundledPrimaryImage : images[0]!,
    attributes: copiedAttributes,
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

function validateAttributes(
  item: ListingDraftItemV2,
  skuId: string,
  category: CategoryAttributesGroupV1,
  weightFacts: CostPricingV1['sku_pricing'][number]['weight_facts'],
  result: ListingDraftV2,
): void {
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
  const description4191 = attributeText(item.attributes, 4191);
  if (!description4191) result.errors.push(issue('DESCRIPTION_4191_MISSING', `SKU ${skuId} lacks description attribute 4191.`, [skuId], [4191]));
  if (description4191 && hasForbiddenOzonDescriptionCharacters(description4191)) {
    result.errors.push(issue(
      'DESCRIPTION_4191_FORBIDDEN_CHARACTERS',
      `SKU ${skuId} description attribute 4191 contains CJK or unsafe control characters rejected by Ozon.`,
      [skuId],
      [4191],
    ));
  }
  const attribute4383 = numericAttribute(item.attributes, 4383);
  if (attribute4383 !== null && attribute4383 !== weightFacts.attribute_4383_weight_g) {
    result.errors.push(issue('WEIGHT_4383_INCONSISTENT', `SKU ${skuId} attribute 4383 does not match audited weight_facts.attribute_4383_weight_g.`, [skuId], [4383]));
  }
  const attribute4497 = numericAttribute(item.attributes, 4497);
  if (attribute4497 !== null && attribute4497 !== weightFacts.platform_attribute_weight_g) {
    result.errors.push(issue('WEIGHT_4497_INCONSISTENT', `SKU ${skuId} attribute 4497 does not match the explicitly audited platform_attribute_weight_g compatibility value.`, [skuId], [4497]));
  }
  if (byId.has(10096)) {
    const color = item.attributes.find((attribute) => attribute.id === 10096);
    const multicolor = byId.get(10096)!.values.find((value) => /多色|многоцвет|multicolor/iu.test(value.value));
    if (!color) result.errors.push(issue('COLOR_10096_MISSING', `SKU ${skuId} must include color attribute 10096.`, [skuId], [10096]));
    if (color && color.values.some((value) => value.dictionary_value_id === undefined)) result.errors.push(issue('COLOR_10096_DICTIONARY_ID_REQUIRED', `SKU ${skuId} color must use a real dictionary_value_id.`, [skuId], [10096]));
    // If the mapping selected the policy fallback, it must point to a real “multicolor” candidate.
    if (color && !multicolor && color.values.some((value) => /多色|многоцвет|multicolor/iu.test(value.value))) result.errors.push(issue('COLOR_MULTICOLOR_CANDIDATE_MISSING', `SKU ${skuId} selected multicolor but the snapshot has no multicolor dictionary candidate.`, [skuId], [10096]));
  }
}

function validate9048(groups: CategoryAttributesGroupV1[], mapping: AttributeMappingV2, result: ListingDraftV2): void {
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

function numericAttribute(attributes: OzonReadyAttributeV1[], id: number): number | null {
  const value = attributeText(attributes, id);
  if (value === null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function stableOfferId(offerId: string, skuId: string): string {
  const readable = `1688-${offerId}-${skuId}`.replace(/[^A-Za-z0-9._-]+/g, '-');
  return readable.length <= 50 ? readable : `1688-${createHash('sha256').update(`${offerId}:${skuId}`).digest('hex').slice(0, 40)}`;
}

function issue(code: string, message: string, sku_ids: string[] = [], attribute_ids: number[] = []): ListingDraftIssueV1 {
  return { code, message, sku_ids, attribute_ids };
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stable(object[key])}`).join(',')}}`;
}
