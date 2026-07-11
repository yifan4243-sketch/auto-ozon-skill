import type { CanonicalProduct } from '../../../contracts/src/canonical-product.js';
import type { CollectionMethod } from '../../../contracts/src/common.js';
import {
  normalizePositivePackageValue,
  normalizeRawWeight,
} from '../../../transformer/src/package-value-normalizer.js';
import { parseSkuSpec } from '../../../transformer/src/sku-spec-parser.js';
import type { OfferResult } from '../engine/commands/offers.js';

export function offerToCanonical(
  offer: OfferResult,
  method: CollectionMethod,
  collectedAt = new Date().toISOString(),
): CanonicalProduct {
  const attributes = Object.fromEntries(
    offer.attributes.map((attribute) => [attribute.name, attribute.value]),
  );
  const packageInfo = summarizePackageInfo(offer);
  const images = uniqueStrings([
    offer.mainImage,
    ...offer.images,
    ...offer.skus.map((sku) => sku.image),
  ]);
  const warnings: string[] = [];
  const errors: string[] = [];

  if (!offer.title) errors.push('Missing product title.');
  if (images.length === 0) errors.push('Missing product images.');
  if (offer.priceTiers.length === 0 && offer.priceMin === null) {
    warnings.push('No reliable price tier found.');
  }
  if (offer.skus.length === 0) warnings.push('No SKU variants found.');

  return {
    source: {
      platform: '1688',
      offerId: offer.offerId,
      offerUrl: offer.url,
      collectedAt,
      collectionMethod: method,
      sourceCategoryPathZh: [...(offer.categoryPathZh ?? [])],
    },
    product: {
      chineseTitle: offer.title,
      originalImages: images,
      detailImages: offer.detailUrl ? [offer.detailUrl] : [],
      attributes,
      priceTiers: normalizePriceTiers(offer),
      skus: offer.skus.map((sku) => ({
        sourceSkuId: String(sku.skuId),
        specs: sku.specs,
        priceCny: sku.price,
        image: sku.image,
        attributes: parseSkuSpec({
          raw_spec_text: sku.specs,
          options: offer.options,
        }).specs,
      })),
      ...(packageInfo ? { packageInfo } : {}),
    },
    validation: {
      status: errors.length > 0 ? 'blocked' : warnings.length > 0 ? 'warning' : 'valid',
      warnings,
      errors,
    },
  };
}

function normalizePriceTiers(offer: OfferResult): Array<{ minQty: number; priceCny: number }> {
  if (offer.priceTiers.length > 0) {
    return offer.priceTiers.map((tier) => ({
      minQty: tier.minQty,
      priceCny: tier.price,
    }));
  }
  if (offer.priceMin !== null) {
    return [{ minQty: offer.minOrderQty ?? 1, priceCny: offer.priceMin }];
  }
  return [];
}

function summarizePackageInfo(
  offer: OfferResult,
): CanonicalProduct['product']['packageInfo'] | null {
  for (const item of offer.packageInfo) {
    const summary = {
      rawWeight: normalizeRawWeight(item.weight),
      weightUnit: 'unknown' as const,
      lengthCm: normalizePositivePackageValue(item.length),
      widthCm: normalizePositivePackageValue(item.width),
      heightCm: normalizePositivePackageValue(item.height),
    };
    if (
      summary.rawWeight !== null ||
      summary.lengthCm !== null ||
      summary.widthCm !== null ||
      summary.heightCm !== null
    ) {
      return summary;
    }
  }
  return null;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => !!value))];
}
