import type {
  CanonicalProductV2,
  CommandResult,
  ListingPayloadV1,
  OzonImportItemV1,
  OzonProductDraftV2,
  StorePublishProfileV1,
} from '@auto-ozon/contracts';
import { sha256Json, type WorkflowContext } from '@auto-ozon/artifact-store';

export const OZON_SELLER_SWAGGER_SHA256 = 'c54962e9481ac776e14c0fe4f987e0ff74fde68a793e6b640f70db6cdaabdba5';

export interface RunListingPayloadInput {
  run_id: string;
  product: CanonicalProductV2;
  draft: OzonProductDraftV2;
  profile: StorePublishProfileV1;
}

export async function runListingPayload(
  input: RunListingPayloadInput,
  context?: WorkflowContext,
): Promise<CommandResult<ListingPayloadV1>> {
  try {
    if (context) await context.artifact_store.updateStep(context.run_id, 'listing-payload', { status: 'running', step_version: '1.0.0' });
    const payload = buildListingPayload(input);
    if (context) {
      const output = await context.artifact_store.write(context.run_id, 'listing-payload', 'listing-payload-v1.json', payload);
      await context.artifact_store.updateStep(context.run_id, 'listing-payload', { status: 'succeeded', output, step_version: '1.0.0' });
    }
    return { ok: true, command: 'listing.payload', data: payload, warnings: [], errors: [], nextActions: [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (context) await context.artifact_store.updateStep(context.run_id, 'listing-payload', {
      status: 'blocked', error: { code: 'LISTING_PAYLOAD_INVALID', message, recoverable: true }, step_version: '1.0.0',
    });
    return { ok: false, command: 'listing.payload', warnings: [], errors: [{ code: 'LISTING_PAYLOAD_INVALID', message, recoverable: true }], nextActions: [] };
  }
}

export function buildListingPayload(input: RunListingPayloadInput): ListingPayloadV1 {
  validateProfile(input.profile);
  if (input.draft.publish_readiness !== 'ready' || input.draft.status !== 'draft_complete') {
    throw new Error('Draft is not publish-ready.');
  }
  if (input.product.source.offer_id !== input.draft.source_offer_id) throw new Error('Draft and product offer IDs differ.');
  const skuById = new Map(input.product.skus.map((sku) => [sku.source_sku_id, sku]));
  const skuOfferIds: Record<string, string> = {};
  const items: OzonImportItemV1[] = input.draft.items.map((draftItem) => {
    const sku = skuById.get(draftItem.source_sku_id);
    if (!sku) throw new Error(`Draft references unknown SKU ${draftItem.source_sku_id}.`);
    if (draftItem.publish_readiness !== 'ready') throw new Error(`SKU ${draftItem.source_sku_id} is not publish-ready.`);
    const purchasePrice = sku.price_cny ?? sku.multi_price_cny;
    if (purchasePrice === null || !Number.isFinite(purchasePrice) || purchasePrice <= 0) {
      throw new Error(`SKU ${draftItem.source_sku_id} has no valid CNY purchase price.`);
    }
    const offerId = stableOfferId(input.product.source.offer_id, draftItem.source_sku_id);
    skuOfferIds[draftItem.source_sku_id] = offerId;
    const images = validImages([sku.image, input.product.product.main_image, ...input.product.product.gallery_images]);
    if (images.length === 0) throw new Error(`SKU ${draftItem.source_sku_id} has no valid source image URL.`);
    const pkg = sku.package;
    if ([pkg.length_cm, pkg.width_cm, pkg.height_cm, pkg.raw_weight].some((value) => value === null || !Number.isFinite(value) || value! <= 0)) {
      throw new Error(`SKU ${draftItem.source_sku_id} has incomplete logistics dimensions or weight.`);
    }
    if (pkg.weight_unit === 'unknown') throw new Error(`SKU ${draftItem.source_sku_id} has unknown package weight unit.`);
    const weight = pkg.weight_unit === 'kg' ? pkg.raw_weight! * 1000 : pkg.raw_weight!;
    return {
      offer_id: offerId,
      description_category_id: draftItem.description_category_id,
      type_id: draftItem.type_id,
      name: draftItem.name,
      price: roundMoney(purchasePrice * input.profile.pricing.markup_multiplier),
      currency_code: 'CNY',
      vat: input.profile.vat,
      attributes: draftItem.attributes.map(({ id, complex_id, values }) => ({ id, complex_id, values })),
      images: images.slice(0, 30),
      primary_image: images[0]!,
      dimension_unit: 'cm',
      depth: pkg.length_cm!, width: pkg.width_cm!, height: pkg.height_cm!,
      weight_unit: 'g', weight: Math.round(weight * 1000) / 1000,
    };
  });
  if (items.length === 0) throw new Error('Listing payload has no items.');
  if (new Set(Object.values(skuOfferIds)).size !== items.length) throw new Error('Generated offer IDs are not unique.');
  const request = { items };
  return {
    schema_version: 1,
    run_id: input.run_id,
    source_offer_id: input.product.source.offer_id,
    request_sha256: sha256Json(request),
    swagger_sha256: OZON_SELLER_SWAGGER_SHA256,
    sku_offer_ids: skuOfferIds,
    request,
    created_at: new Date().toISOString(),
  };
}

function validateProfile(profile: StorePublishProfileV1): void {
  if (!profile.publishing.enabled) throw new Error('Store publishing is disabled.');
  if (!profile.publishing.credentials_ref.trim()) throw new Error('Store credentials_ref is required.');
  if (profile.pricing.currency_code !== 'CNY') throw new Error('Only CNY pricing is supported.');
  if (!Number.isFinite(profile.pricing.markup_multiplier) || profile.pricing.markup_multiplier <= 0) throw new Error('A positive markup multiplier is required.');
  if (!profile.vat.trim()) throw new Error('VAT configuration is required.');
  if (profile.polling.max_retries !== 2 || profile.polling.interval_ms < 100 || profile.polling.timeout_ms <= profile.polling.interval_ms) {
    throw new Error('Invalid polling policy. max_retries must equal 2.');
  }
}

function stableOfferId(offerId: string, skuId: string): string {
  const normalized = `${offerId}-${skuId}`.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-');
  if (normalized.length <= 50) return normalized;
  return `${normalized.slice(0, 37)}-${sha256Json(normalized).slice(0, 12)}`;
}

function validImages(values: Array<string | null>): string[] {
  const result: string[] = [];
  for (const value of values) {
    if (!value || result.includes(value)) continue;
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol)) continue;
      if (!/\.(?:jpe?g|png|webp)$/i.test(url.pathname)) continue;
      result.push(value);
    } catch { /* invalid source URL */ }
  }
  return result;
}

function roundMoney(value: number): string {
  if (!Number.isFinite(value) || value <= 0) throw new Error('Calculated sale price is invalid.');
  return (Math.round((value + Number.EPSILON) * 100) / 100).toFixed(2);
}
