import type { CanonicalProductV2 } from '../../contracts/src/canonical-product-v2.js';
import type {
  CanonicalV2IntegrityProductResult,
  CanonicalV2IntegrityReport,
  CanonicalV2IntegrityViolation,
} from '../../contracts/src/sourcing-result-v2.js';
import {
  normalizePositivePackageValue,
  normalizeRawWeight,
} from './package-value-normalizer.js';
import { normalizeSpecForMatch, parseSkuSpec } from './sku-spec-parser.js';

export interface IntegritySourceSku {
  skuId: string;
  specs: string;
  price: number | null;
  multiPrice: number | null;
  image: string | null;
}

export interface IntegritySourcePackage {
  skuId: string;
  spec: string;
  length: number | null;
  width: number | null;
  height: number | null;
  weight: number | null;
}

export interface IntegritySourceOffer {
  offerId: string;
  title: string;
  url: string;
  detailUrl: string | null;
  categoryPathZh: string[];
  attributes: Array<{ name: string; value: string }>;
  priceMin: number | null;
  minOrderQty: number | null;
  priceTiers: Array<{ minQty: number; price: number }>;
  mainImage: string | null;
  images: string[];
  options: Array<{
    prop: string;
    values: Array<{ name: string; imageUrl: string | null }>;
  }>;
  skus: IntegritySourceSku[];
  packageInfo: IntegritySourcePackage[];
}

export function checkCanonicalV2Integrity(
  offers: IntegritySourceOffer[],
  products: CanonicalProductV2[],
): CanonicalV2IntegrityReport {
  const violations: CanonicalV2IntegrityViolation[] = [];
  const productResults: CanonicalV2IntegrityProductResult[] = [];
  const usedProducts = new Set<CanonicalProductV2>();
  const sourceOfferIds = new Set(offers.map((offer) => offer.offerId));

  offers.forEach((offer, offerIndex) => {
    const productCodes = new Set<string>();
    const matchingProducts = products.filter(
      (product) => product.source.offer_id === offer.offerId,
    );
    let product: CanonicalProductV2 | undefined;

    if (matchingProducts.length === 1) {
      product = matchingProducts[0];
    } else if (matchingProducts.length > 1) {
      product = matchingProducts[0];
      addViolation(
        'DUPLICATE_CANONICAL_PRODUCT',
        offer.offerId,
        null,
        'More than one CanonicalProductV2 has the same offer_id.',
        productCodes,
      );
    } else {
      const positional = products[offerIndex];
      if (positional && !sourceOfferIds.has(positional.source.offer_id)) {
        product = positional;
        addViolation(
          'OFFER_ID_MISMATCH',
          offer.offerId,
          null,
          `Expected offer_id ${offer.offerId}, received ${positional.source.offer_id}.`,
          productCodes,
        );
      } else {
        addViolation(
          'MISSING_CANONICAL_PRODUCT',
          offer.offerId,
          null,
          'A successfully collected OfferResult has no CanonicalProductV2.',
          productCodes,
        );
      }
    }

    if (product) {
      usedProducts.add(product);
      checkProduct(offer, product, productCodes);
    }

    const expectedCount = offer.skus.length > 0 ? offer.skus.length : 1;
    productResults.push({
      offer_id: offer.offerId,
      source_sku_count: offer.skus.length,
      expected_canonical_sku_count: expectedCount,
      canonical_sku_count: product?.skus.length ?? 0,
      passed: productCodes.size === 0,
      violation_codes: [...productCodes],
    });
  });

  for (const product of products) {
    if (usedProducts.has(product)) continue;
    violations.push({
      code: 'UNEXPECTED_CANONICAL_PRODUCT',
      offer_id: product.source.offer_id || null,
      source_sku_id: null,
      message: 'CanonicalProductV2 has no corresponding successful OfferResult.',
    });
  }

  return {
    status: violations.length === 0 ? 'pass' : 'fail',
    checked_product_count: offers.length,
    violations,
    product_results: productResults,
  };

  function addViolation(
    code: string,
    offerId: string | null,
    sourceSkuId: string | null,
    message: string,
    productCodes: Set<string>,
  ): void {
    violations.push({
      code,
      offer_id: offerId,
      source_sku_id: sourceSkuId,
      message,
    });
    productCodes.add(code);
  }

  function checkProduct(
    offer: IntegritySourceOffer,
    product: CanonicalProductV2,
    productCodes: Set<string>,
  ): void {
    if (product.source.offer_id !== offer.offerId) {
      addViolation(
        'OFFER_ID_MISMATCH',
        offer.offerId,
        null,
        `Expected offer_id ${offer.offerId}, received ${product.source.offer_id}.`,
        productCodes,
      );
    }
    if (product.source.detail_url !== offer.detailUrl) {
      addViolation(
        'DETAIL_URL_MISMATCH',
        offer.offerId,
        null,
        'detail_url changed during canonical conversion.',
        productCodes,
      );
    }
    if (product.source.offer_url !== offer.url) {
      addViolation(
        'OFFER_URL_MISMATCH',
        offer.offerId,
        null,
        '1688 offer URL changed during canonical conversion.',
        productCodes,
      );
    }
    if (!arraysEqual(product.source.source_category_path_zh, offer.categoryPathZh)) {
      addViolation(
        'SOURCE_CATEGORY_MISMATCH',
        offer.offerId,
        null,
        '1688 Chinese category path changed during canonical conversion.',
        productCodes,
      );
    }
    if (product.product.title_zh !== offer.title) {
      addViolation(
        'PRODUCT_TITLE_MISMATCH',
        offer.offerId,
        null,
        '1688 title changed during canonical conversion.',
        productCodes,
      );
    }
    const expectedAttributes = Object.fromEntries(
      offer.attributes
        .filter((attribute) => attribute.name.trim())
        .map((attribute) => [attribute.name, attribute.value]),
    );
    if (!recordsEqual(product.product.attributes, expectedAttributes)) {
      addViolation(
        'PRODUCT_ATTRIBUTES_MISMATCH',
        offer.offerId,
        null,
        '1688 attributes changed during canonical conversion.',
        productCodes,
      );
    }
    if (product.product.main_image !== offer.mainImage) {
      addViolation(
        'MAIN_IMAGE_MISMATCH',
        offer.offerId,
        null,
        '1688 main image changed during canonical conversion.',
        productCodes,
      );
    }
    const expectedGallery = [...new Set(offer.images.map((image) => image.trim()).filter(Boolean))]
      .filter((image) => image !== offer.detailUrl);
    if (!arraysEqual(product.product.gallery_images, expectedGallery)) {
      addViolation(
        'GALLERY_IMAGES_MISMATCH',
        offer.offerId,
        null,
        '1688 gallery images changed during canonical conversion.',
        productCodes,
      );
    }
    const expectedPriceTiers = offer.priceTiers.length > 0
      ? offer.priceTiers.map((tier) => ({
          min_qty: tier.minQty,
          price_cny: tier.price,
        }))
      : offer.priceMin !== null
        ? [{ min_qty: offer.minOrderQty ?? 1, price_cny: offer.priceMin }]
        : [];
    if (JSON.stringify(product.product.price_tiers) !== JSON.stringify(expectedPriceTiers)) {
      addViolation(
        'PRICE_TIERS_MISMATCH',
        offer.offerId,
        null,
        '1688 price tiers changed during canonical conversion.',
        productCodes,
      );
    }
    const expectedOptions = offer.options.map((option) => ({
      source_name: option.prop,
      values: option.values.map((value) => ({
        value: value.name,
        image_url: value.imageUrl,
      })),
    }));
    if (JSON.stringify(product.product.sku_options) !== JSON.stringify(expectedOptions)) {
      addViolation(
        'SKU_OPTIONS_MISMATCH',
        offer.offerId,
        null,
        '1688 SKU options changed during canonical conversion.',
        productCodes,
      );
    }

    const expectedSkuCount = offer.skus.length > 0 ? offer.skus.length : 1;
    if (product.skus.length !== expectedSkuCount) {
      addViolation(
        'SKU_COUNT_MISMATCH',
        offer.offerId,
        null,
        `Expected ${expectedSkuCount} canonical SKU(s), received ${product.skus.length}.`,
        productCodes,
      );
    }

    if (offer.skus.length === 0) {
      const defaultSkus = product.skus.filter((sku) => sku.source_sku_id === 'DEFAULT');
      if (product.skus.length !== 1 || defaultSkus.length !== 1) {
        addViolation(
          'DEFAULT_SKU_MISMATCH',
          offer.offerId,
          null,
          'A no-SKU OfferResult must produce exactly one DEFAULT SKU.',
          productCodes,
        );
      }
      const canonicalDefault = product.skus[0];
      if (canonicalDefault) {
        const expectedDefaultPrice =
          offer.priceMin ??
          minimumFinite(offer.priceTiers.map((tier) => tier.price));
        if (!Object.is(canonicalDefault.price_cny, expectedDefaultPrice)) {
          addViolation(
            'DEFAULT_SKU_PRICE_MISMATCH',
            offer.offerId,
            'DEFAULT',
            'DEFAULT SKU price changed during canonical conversion.',
            productCodes,
          );
        }
        if (!Object.is(canonicalDefault.image, offer.mainImage)) {
          addViolation(
            'DEFAULT_SKU_IMAGE_MISMATCH',
            offer.offerId,
            'DEFAULT',
            'DEFAULT SKU image must preserve the source main image.',
            productCodes,
          );
        }
        checkPackage(
          offer,
          null,
          canonicalDefault,
          uniqueDefaultPackage(offer.packageInfo),
          productCodes,
          addViolation,
        );
      }
    } else {
      checkSourceSkuIds(offer, product, productCodes, addViolation);
      const sourceIdCounts = countNormalizedIds(offer.skus.map((sku) => sku.skuId));
      offer.skus.forEach((sourceSku, index) => {
        const normalizedId = sourceSku.skuId.trim();
        const canonicalSku =
          normalizedId && sourceIdCounts.get(normalizedId) === 1
            ? product.skus.find((sku) => sku.source_sku_id === normalizedId)
            : product.skus[index];
        if (!canonicalSku) {
          addViolation(
            'MISSING_CANONICAL_SKU',
            offer.offerId,
            normalizedId || null,
            'A source SKU has no corresponding canonical SKU.',
            productCodes,
          );
          return;
        }
        compareSkuFacts(
          offer,
          sourceSku,
          canonicalSku,
          productCodes,
          addViolation,
        );
        checkPackage(
          offer,
          sourceSku,
          canonicalSku,
          expectedPackageForSku(sourceSku, offer.packageInfo),
          productCodes,
          addViolation,
        );
      });
    }

    if (
      offer.detailUrl &&
      product.product.gallery_images.includes(offer.detailUrl)
    ) {
      addViolation(
        'DETAIL_URL_IN_GALLERY',
        offer.offerId,
        null,
        'detail_url must not appear in gallery_images.',
        productCodes,
      );
    }

    for (const sku of product.skus) {
      if (Object.keys(sku.specs).some((key) => /^spec\d+$/i.test(key))) {
        addViolation(
          'NUMBERED_SPEC_KEY',
          offer.offerId,
          sku.source_sku_id || null,
          'Canonical SKU specs must not contain spec1/spec2/spec3-style keys.',
          productCodes,
        );
      }
    }
  }
}

type ViolationRecorder = (
  code: string,
  offerId: string | null,
  sourceSkuId: string | null,
  message: string,
  productCodes: Set<string>,
) => void;

function checkSourceSkuIds(
  offer: IntegritySourceOffer,
  product: CanonicalProductV2,
  productCodes: Set<string>,
  addViolation: ViolationRecorder,
): void {
  const normalizedIds = offer.skus.map((sku) => sku.skuId.trim());
  const counts = countNormalizedIds(normalizedIds);
  const invalidIds = normalizedIds.some((id) => !id || (counts.get(id) ?? 0) > 1);
  if (invalidIds && product.validation.status !== 'blocked') {
    addViolation(
      'INVALID_SKU_ID_NOT_BLOCKED',
      offer.offerId,
      null,
      'Empty or duplicate source SKU IDs must block validation.',
      productCodes,
    );
  }

  for (const [id, count] of counts) {
    if (!id || count !== 1) continue;
    const canonicalCount = product.skus.filter((sku) => sku.source_sku_id === id).length;
    if (canonicalCount !== 1) {
      addViolation(
        'SOURCE_SKU_ID_MISMATCH',
        offer.offerId,
        id,
        `Unique source skuId ${id} must occur exactly once in canonical SKUs.`,
        productCodes,
      );
    }
  }
}

function compareSkuFacts(
  offer: IntegritySourceOffer,
  source: IntegritySourceSku,
  canonical: CanonicalProductV2['skus'][number],
  productCodes: Set<string>,
  addViolation: ViolationRecorder,
): void {
  compare('SKU_PRICE_MISMATCH', source.price, canonical.price_cny, 'price');
  compare(
    'SKU_MULTI_PRICE_MISMATCH',
    source.multiPrice,
    canonical.multi_price_cny,
    'multiPrice',
  );
  compare('SKU_IMAGE_MISMATCH', source.image, canonical.image, 'image');
  compare('SKU_RAW_SPEC_MISMATCH', source.specs, canonical.raw_spec_text, 'raw specs');
  const parsed = parseSkuSpec({
    raw_spec_text: source.specs,
    options: offer.options,
  });
  if (!recordsEqual(canonical.specs, parsed.specs)) {
    addViolation(
      'SKU_PARSED_SPEC_MISMATCH',
      offer.offerId,
      source.skuId.trim() || null,
      'Source SKU parsed specs changed during canonical conversion.',
      productCodes,
    );
  }

  function compare(
    code: string,
    expected: unknown,
    actual: unknown,
    field: string,
  ): void {
    if (Object.is(expected, actual)) return;
    addViolation(
      code,
      offer.offerId,
      source.skuId.trim() || null,
      `Source SKU ${field} changed during canonical conversion.`,
      productCodes,
    );
  }
}

interface ExpectedPackageMatch {
  item: IntegritySourcePackage;
  matchedBy: 'sku_id' | 'exact_spec' | 'none';
}

function expectedPackageForSku(
  sku: IntegritySourceSku,
  packages: IntegritySourcePackage[],
): ExpectedPackageMatch | null {
  const skuId = sku.skuId.trim();
  if (skuId) {
    const byId = packages.find((item) => item.skuId.trim() === skuId);
    if (byId) return { item: byId, matchedBy: 'sku_id' };
  }
  const spec = normalizeSpecForMatch(sku.specs);
  if (!spec) return null;
  const matches = packages.filter(
    (item) => normalizeSpecForMatch(item.spec) === spec,
  );
  return matches.length === 1
    ? { item: matches[0]!, matchedBy: 'exact_spec' }
    : null;
}

function uniqueDefaultPackage(
  packages: IntegritySourcePackage[],
): ExpectedPackageMatch | null {
  return packages.length === 1
    ? { item: packages[0]!, matchedBy: 'none' }
    : null;
}

function checkPackage(
  offer: IntegritySourceOffer,
  sourceSku: IntegritySourceSku | null,
  canonicalSku: CanonicalProductV2['skus'][number],
  expected: ExpectedPackageMatch | null,
  productCodes: Set<string>,
  addViolation: ViolationRecorder,
): void {
  const skuId = sourceSku?.skuId.trim() || canonicalSku.source_sku_id || null;
  if (!expected) {
    if (
      canonicalSku.package.matched_by !== 'none' ||
      canonicalSku.package.length_cm !== null ||
      canonicalSku.package.width_cm !== null ||
      canonicalSku.package.height_cm !== null ||
      canonicalSku.package.raw_weight !== null ||
      canonicalSku.package.weight_unit !== 'unknown'
    ) {
      addViolation(
        'UNMATCHED_PACKAGE_INHERITED',
        offer.offerId,
        skuId,
        'An unmatched SKU inherited package facts.',
        productCodes,
      );
    }
    return;
  }

  if (canonicalSku.package.matched_by !== expected.matchedBy) {
    addViolation(
      'PACKAGE_MATCH_METHOD_MISMATCH',
      offer.offerId,
      skuId,
      `Expected package match ${expected.matchedBy}, received ${canonicalSku.package.matched_by}.`,
      productCodes,
    );
  }
  if (
    expected.matchedBy === 'sku_id' &&
    (!sourceSku || expected.item.skuId.trim() !== sourceSku.skuId.trim())
  ) {
    addViolation(
      'INVALID_SKU_ID_PACKAGE_MATCH',
      offer.offerId,
      skuId,
      'matched_by=sku_id does not point to the same source skuId.',
      productCodes,
    );
  }
  if (expected.matchedBy === 'exact_spec' && sourceSku) {
    const matches = offer.packageInfo.filter(
      (item) =>
        normalizeSpecForMatch(item.spec) === normalizeSpecForMatch(sourceSku.specs),
    );
    if (matches.length !== 1) {
      addViolation(
        'AMBIGUOUS_EXACT_SPEC_PACKAGE_MATCH',
        offer.offerId,
        skuId,
        'matched_by=exact_spec requires exactly one normalized specification match.',
        productCodes,
      );
    }
  }

  const expectedValues = {
    length_cm: normalizePositivePackageValue(expected.item.length),
    width_cm: normalizePositivePackageValue(expected.item.width),
    height_cm: normalizePositivePackageValue(expected.item.height),
    raw_weight: normalizeRawWeight(expected.item.weight),
  };
  for (const [field, expectedValue] of Object.entries(expectedValues)) {
    const actual = canonicalSku.package[field as keyof typeof expectedValues];
    if (Object.is(actual, expectedValue)) continue;
    addViolation(
      field === 'raw_weight'
        ? 'PACKAGE_WEIGHT_MISMATCH'
        : 'PACKAGE_MEASUREMENT_MISMATCH',
      offer.offerId,
      skuId,
      `Package ${field} changed during canonical conversion.`,
      productCodes,
    );
  }
  if (canonicalSku.package.weight_unit !== 'unknown') {
    addViolation(
      'PACKAGE_WEIGHT_UNIT_MISMATCH',
      offer.offerId,
      skuId,
      'OfferResult has no explicit package weight unit, so canonical unit must remain unknown.',
      productCodes,
    );
  }
}

function countNormalizedIds(ids: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const raw of ids) {
    const id = raw.trim();
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

function minimumFinite(values: number[]): number | null {
  const finite = values.filter(Number.isFinite);
  return finite.length > 0 ? Math.min(...finite) : null;
}

function recordsEqual(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  return leftEntries.length === rightEntries.length &&
    leftEntries.every(([key, value]) => right[key] === value);
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
