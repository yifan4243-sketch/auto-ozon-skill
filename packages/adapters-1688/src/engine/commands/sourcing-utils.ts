import { CliError } from '../io/errors.js';
import type { Offer } from '../session/search-mtop.js';

export type SearchSort = 'relevance' | 'price-asc' | 'price-desc';

export interface SearchFilterInput {
  priceMin?: number | null;
  priceMax?: number | null;
}

export interface SearchFilterSummary {
  priceMin: number | null;
  priceMax: number | null;
}

export function normalizeSearchSort(raw: string | undefined): SearchSort {
  const value = (raw ?? 'relevance').trim();
  if (value === 'relevance' || value === 'price-asc' || value === 'price-desc') {
    return value;
  }
  throw new CliError(
    2,
    'BAD_INPUT',
    `Invalid --sort: ${value}. Use relevance | price-asc | price-desc.`,
  );
}

export function parseOptionalNumber(
  raw: string | undefined,
  flag: string,
): number | null {
  if (raw === undefined || raw === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new CliError(2, 'BAD_INPUT', `Invalid ${flag}: ${raw}.`);
  }
  return value;
}

export function parsePositiveInt(
  raw: string | undefined,
  flag: string,
  fallback: number,
  cap?: number,
): number {
  const value = Number(raw ?? fallback);
  if (!Number.isInteger(value) || value < 1) {
    throw new CliError(2, 'BAD_INPUT', `Invalid ${flag}: ${raw}.`);
  }
  return cap ? Math.min(value, cap) : value;
}

export function normalizeFilters(input: SearchFilterInput): SearchFilterSummary {
  const priceMin = input.priceMin ?? null;
  const priceMax = input.priceMax ?? null;
  if (priceMin !== null && priceMin < 0) {
    throw new CliError(2, 'BAD_INPUT', '--price-min must be zero or greater.');
  }
  if (priceMax !== null && priceMax < 0) {
    throw new CliError(2, 'BAD_INPUT', '--price-max must be zero or greater.');
  }
  if (priceMin !== null && priceMax !== null && priceMin > priceMax) {
    throw new CliError(2, 'BAD_INPUT', '--price-min must not exceed --price-max.');
  }
  return { priceMin, priceMax };
}

export function hasActiveFilters(filters: SearchFilterSummary): boolean {
  return filters.priceMin !== null || filters.priceMax !== null;
}

export function applySearchControls(
  offers: Offer[],
  sort: SearchSort,
  filters: SearchFilterSummary,
): Offer[] {
  const filtered = offers.filter((offer) => offerMatchesFilters(offer, filters));
  return sortOffers(filtered, sort);
}

export function offerMatchesFilters(
  offer: Offer,
  filters: SearchFilterSummary,
): boolean {
  const price = offer.price.min ?? offer.price.max;
  if (filters.priceMin !== null && (price === null || price < filters.priceMin)) {
    return false;
  }
  if (filters.priceMax !== null && (price === null || price > filters.priceMax)) {
    return false;
  }
  return true;
}

export function sortOffers(offers: Offer[], sort: SearchSort): Offer[] {
  if (sort === 'relevance') return [...offers];
  return [...offers].sort((left, right) => {
    if (sort === 'price-asc') {
      return nullableNumberLast(left.price.min) - nullableNumberLast(right.price.min);
    }
    return nullableNumberLastDesc(right.price.min) - nullableNumberLastDesc(left.price.min);
  });
}

function nullableNumberLast(value: number | null): number {
  return value === null ? Number.POSITIVE_INFINITY : value;
}

function nullableNumberLastDesc(value: number | null): number {
  return value === null ? Number.NEGATIVE_INFINITY : value;
}
