import type { CanonicalProduct } from '../../../contracts/src/canonical-product.js';
import type { CollectionMethod } from '../../../contracts/src/common.js';
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
    },
    supplier: {
      name: offer.supplier.name,
      loginId: offer.supplier.loginId,
      memberId: offer.supplier.memberId,
      userId: offer.supplier.userId,
      location: [offer.freight.province, offer.freight.city].filter(Boolean).join(' ') || null,
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
        stock: sku.stock,
        image: sku.image,
        attributes: parseSkuAttributes(sku.specs),
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
  const first = offer.packageInfo.find(
    (item) =>
      item.weight !== null ||
      item.length !== null ||
      item.width !== null ||
      item.height !== null,
  );
  if (!first) return null;
  return {
    weightKg: normalizeWeightKg(first.weight),
    lengthCm: first.length,
    widthCm: first.width,
    heightCm: first.height,
  };
}

function normalizeWeightKg(weight: number | null): number | null {
  if (weight === null) return null;
  return weight > 100 ? weight / 1000 : weight;
}

function parseSkuAttributes(specs: string): Record<string, string> {
  const out: Record<string, string> = {};
  const parts = specs
    .replace(/&gt;/g, '>')
    .split('>')
    .map((part) => part.trim())
    .filter(Boolean);
  parts.forEach((part, index) => {
    out[`spec${index + 1}`] = part;
  });
  return out;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => !!value))];
}
