import { CliError } from '../engine/io/errors.js';
import type {
  OfferBatchResult,
  OfferFailure,
  OfferResult,
  PriceTier,
  ProductAttribute,
  SkuOption,
  SkuPackage,
  SkuVariant,
} from '../engine/commands/offers.js';
import { normalizeCategoryPathZh } from '../engine/commands/offers.js';

export type OfflineOfferInput =
  | { kind: 'single'; offer: OfferResult }
  | { kind: 'batch'; batch: OfferBatchResult };

export function parseOfflineOfferInput(value: unknown): OfflineOfferInput {
  const input = expectRecord(value, 'input');
  if ('offerId' in input) {
    return { kind: 'single', offer: parseOfferResult(input, 'input') };
  }
  if (input.mode === 'offers' && Array.isArray(input.offers)) {
    return { kind: 'batch', batch: parseOfferBatchResult(input, 'input') };
  }
  throw badInput(
    'input must be one OfferResult or an OfferBatchResult with mode="offers" and offers[].',
  );
}

/** Rebuild an OfferResult from known fields so unknown or secret-like keys are dropped. */
export function sanitizeOfferResult(value: OfferResult): OfferResult {
  return parseOfferResult(value, 'offer');
}

export function sanitizeOfferBatchResult(value: OfferBatchResult): OfferBatchResult {
  return parseOfferBatchResult(value, 'batch');
}

export function parseOfferResult(value: unknown, label = 'offer'): OfferResult {
  const input = expectRecord(value, label);

  return {
    offerId: expectString(input.offerId, `${label}.offerId`),
    title: expectString(input.title, `${label}.title`),
    url: expectString(input.url, `${label}.url`),
    categoryPathZh: normalizeCategoryPathZh(
      expectOptionalArray(input.categoryPathZh, `${label}.categoryPathZh`).map(
        (item, index) =>
          expectString(item, `${label}.categoryPathZh[${index}]`),
      ),
    ),
    priceRange: expectNullableString(input.priceRange, `${label}.priceRange`),
    priceMin: expectNullableNumber(input.priceMin, `${label}.priceMin`),
    priceMax: expectNullableNumber(input.priceMax, `${label}.priceMax`),
    unitName: expectNullableString(input.unitName, `${label}.unitName`),
    minOrderQty: expectNullableNumber(input.minOrderQty, `${label}.minOrderQty`),
    mixOrderQty: expectNullableNumber(input.mixOrderQty, `${label}.mixOrderQty`),
    priceTiers: expectArray(input.priceTiers, `${label}.priceTiers`).map(
      (item, index): PriceTier => {
        const tier = expectRecord(item, `${label}.priceTiers[${index}]`);
        return {
          minQty: expectNumber(tier.minQty, `${label}.priceTiers[${index}].minQty`),
          price: expectNumber(tier.price, `${label}.priceTiers[${index}].price`),
        };
      },
    ),
    detailUrl: expectNullableString(input.detailUrl, `${label}.detailUrl`),
    attributes: expectArray(input.attributes, `${label}.attributes`).map(
      (item, index): ProductAttribute => {
        const attribute = expectRecord(item, `${label}.attributes[${index}]`);
        return {
          name: expectString(attribute.name, `${label}.attributes[${index}].name`),
          value: expectString(attribute.value, `${label}.attributes[${index}].value`),
        };
      },
    ),
    packageInfo: expectArray(input.packageInfo, `${label}.packageInfo`).map(
      (item, index): SkuPackage => {
        const pkg = expectRecord(item, `${label}.packageInfo[${index}]`);
        return {
          skuId: expectIdentifierString(
            pkg.skuId,
            `${label}.packageInfo[${index}].skuId`,
          ),
          spec: expectString(pkg.spec, `${label}.packageInfo[${index}].spec`),
          length: expectNullableNumber(pkg.length, `${label}.packageInfo[${index}].length`),
          width: expectNullableNumber(pkg.width, `${label}.packageInfo[${index}].width`),
          height: expectNullableNumber(pkg.height, `${label}.packageInfo[${index}].height`),
          weight: expectNullableNumber(pkg.weight, `${label}.packageInfo[${index}].weight`),
        };
      },
    ),
    options: expectArray(input.options, `${label}.options`).map(
      (item, optionIndex): SkuOption => {
        const option = expectRecord(item, `${label}.options[${optionIndex}]`);
        return {
          prop: expectString(option.prop, `${label}.options[${optionIndex}].prop`),
          values: expectArray(
            option.values,
            `${label}.options[${optionIndex}].values`,
          ).map((value, valueIndex) => {
            const entry = expectRecord(
              value,
              `${label}.options[${optionIndex}].values[${valueIndex}]`,
            );
            return {
              name: expectString(
                entry.name,
                `${label}.options[${optionIndex}].values[${valueIndex}].name`,
              ),
              imageUrl: expectNullableString(
                entry.imageUrl,
                `${label}.options[${optionIndex}].values[${valueIndex}].imageUrl`,
              ),
            };
          }),
        };
      },
    ),
    skus: expectArray(input.skus, `${label}.skus`).map(
      (item, index): SkuVariant => {
        const sku = expectRecord(item, `${label}.skus[${index}]`);
        return {
          skuId: expectIdentifierString(sku.skuId, `${label}.skus[${index}].skuId`),
          specs: expectString(sku.specs, `${label}.skus[${index}].specs`),
          price: expectNullableNumber(sku.price, `${label}.skus[${index}].price`),
          multiPrice: expectNullableNumber(
            sku.multiPrice,
            `${label}.skus[${index}].multiPrice`,
          ),
          image: expectNullableString(sku.image, `${label}.skus[${index}].image`),
        };
      },
    ),
    mainImage: expectNullableString(input.mainImage, `${label}.mainImage`),
    images: expectArray(input.images, `${label}.images`).map((item, index) =>
      expectString(item, `${label}.images[${index}]`),
    ),
  };
}

export function parseOfferBatchResult(value: unknown, label = 'batch'): OfferBatchResult {
  const input = expectRecord(value, label);
  if (input.mode !== 'offers') {
    throw badInput(`${label}.mode must equal "offers".`);
  }
  return {
    mode: 'offers',
    total: expectNumber(input.total, `${label}.total`),
    success: expectNumber(input.success, `${label}.success`),
    failed: expectNumber(input.failed, `${label}.failed`),
    offerIds: expectArray(input.offerIds, `${label}.offerIds`).map((item, index) =>
      expectString(item, `${label}.offerIds[${index}]`),
    ),
    offers: expectArray(input.offers, `${label}.offers`).map((item, index) =>
      parseOfferResult(item, `${label}.offers[${index}]`),
    ),
    failures: expectArray(input.failures, `${label}.failures`).map(
      (item, index): OfferFailure => {
        const failure = expectRecord(item, `${label}.failures[${index}]`);
        return {
          offerId: expectString(failure.offerId, `${label}.failures[${index}].offerId`),
          code: expectString(failure.code, `${label}.failures[${index}].code`),
          message: expectString(failure.message, `${label}.failures[${index}].message`),
        };
      },
    ),
  };
}

function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw badInput(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function expectArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw badInput(`${path} must be an array.`);
  return value;
}

function expectOptionalArray(value: unknown, path: string): unknown[] {
  return value === undefined ? [] : expectArray(value, path);
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== 'string') throw badInput(`${path} must be a string.`);
  return value;
}

/** 1688 emits SKU identifiers as either JSON strings or integers. */
function expectIdentifierString(value: unknown, path: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  throw badInput(`${path} must be a string or safe integer.`);
}

function expectNullableString(value: unknown, path: string): string | null {
  if (value === null) return null;
  return expectString(value, path);
}

function expectNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw badInput(`${path} must be a finite number.`);
  }
  return value;
}

function expectNullableNumber(value: unknown, path: string): number | null {
  if (value === null) return null;
  return expectNumber(value, path);
}

function badInput(message: string): CliError {
  return new CliError(2, 'BAD_INPUT', message);
}
