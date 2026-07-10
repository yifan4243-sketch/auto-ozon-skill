import type { CanonicalProductV2 } from '../../../contracts/src/canonical-product-v2.js';
import type { CollectionMethod } from '../../../contracts/src/common.js';
import { assembleCanonicalSkus } from '../../../transformer/src/sku-assembler.js';
import { analyzeSkuVariants } from '../../../transformer/src/variant-analyzer.js';
import { validateSourceSkuIds } from '../../../transformer/src/sku-identifier.js';
import type { OfferResult } from '../engine/commands/offers.js';

export function offerToCanonicalV2(
  offer: OfferResult,
  method: CollectionMethod,
  collectedAt = new Date().toISOString(),
): CanonicalProductV2 {
  const skus = assembleCanonicalSkus({
    skus: offer.skus,
    packageInfo: offer.packageInfo,
    options: offer.options,
    priceMin: offer.priceMin,
    priceTiers: offer.priceTiers,
    mainImage: offer.mainImage,
  });
  const sourceDimensionNames = uniqueStrings(offer.options.map((option) => option.prop));
  const skuAnalysis = analyzeSkuVariants({
    skus,
    hasSourceSkus: offer.skus.length > 0,
    sourceDimensionNames,
  });
  const galleryImages = uniqueStrings(offer.images).filter(
    (image) => image !== offer.detailUrl,
  );
  const warnings = [...skuAnalysis.warnings];
  const errors = validateSourceSkuIds(offer.skus.map((sku) => sku.skuId));

  if (!offer.offerId) errors.push('Missing source offer ID.');
  if (!offer.title.trim()) errors.push('Missing product title.');
  if (!offer.mainImage && galleryImages.length === 0) warnings.push('Missing product images.');
  if (offer.priceTiers.length === 0 && offer.priceMin === null) {
    warnings.push('No reliable source price found.');
  }
  if (offer.skus.length === 0) warnings.push('No source SKUs; generated DEFAULT SKU.');

  const needsReview =
    skuAnalysis.duplicate_spec_combinations.length > 0 ||
    skus.some((sku) => sku.unparsed_spec_segments.length > 0);

  return {
    schema_version: 2,
    source: {
      platform: '1688',
      offer_id: offer.offerId,
      offer_url: offer.url,
      collected_at: collectedAt,
      collection_method: method,
      detail_url: offer.detailUrl,
      source_category_id: offer.categoryId,
    },
    supplier: {
      name: offer.supplier.name,
      login_id: offer.supplier.loginId,
      member_id: offer.supplier.memberId,
      user_id: offer.supplier.userId,
      location: [offer.freight.province, offer.freight.city].filter(Boolean).join(' ') || null,
    },
    product: {
      title_zh: offer.title,
      main_image: offer.mainImage,
      gallery_images: galleryImages,
      attributes: Object.fromEntries(
        offer.attributes
          .filter((attribute) => attribute.name.trim())
          .map((attribute) => [attribute.name, attribute.value]),
      ),
      price_tiers: normalizePriceTiers(offer),
      sku_options: offer.options.map((option) => ({
        source_name: option.prop,
        values: option.values.map((value) => ({
          value: value.name,
          image_url: value.imageUrl,
        })),
      })),
    },
    skus,
    sku_analysis: skuAnalysis,
    validation: {
      status:
        errors.length > 0
          ? 'blocked'
          : needsReview
            ? 'needs_review'
            : warnings.length > 0
              ? 'warning'
              : 'valid',
      warnings: uniqueStrings(warnings),
      errors,
    },
  };
}

function normalizePriceTiers(
  offer: OfferResult,
): CanonicalProductV2['product']['price_tiers'] {
  if (offer.priceTiers.length > 0) {
    return offer.priceTiers.map((tier) => ({
      min_qty: tier.minQty,
      price_cny: tier.price,
    }));
  }
  if (offer.priceMin !== null) {
    return [{ min_qty: offer.minOrderQty ?? 1, price_cny: offer.priceMin }];
  }
  return [];
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => !!value))];
}
