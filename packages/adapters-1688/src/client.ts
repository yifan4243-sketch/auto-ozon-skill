import type { CommandResult, ErrorObject } from '../../contracts/src/command-result.js';
import type { SourcingResult } from '../../contracts/src/sourcing-result.js';
import type { CollectionMethod } from '../../contracts/src/common.js';
import { dispatch } from './engine/session/dispatch.js';
import { CliError } from './engine/io/errors.js';
import { run as loginRun, type LoginOpts } from './engine/commands/login.js';
import { run as logoutRun, type LogoutOpts } from './engine/commands/logout.js';
import { run as doctorRun, type DoctorOpts } from './engine/commands/doctor.js';
import type { WhoamiArgs, WhoamiResult } from './engine/commands/whoami.js';
import type { SearchArgs, SearchResult } from './engine/commands/search.js';
import type { ImageSearchArgs, ImageSearchResult } from './engine/commands/image-search.js';
import type { SimilarArgs, SimilarResult } from './engine/commands/similar.js';
import {
  collectOffersBatch,
  normalizeOfferIds,
  type OfferBatchResult,
} from './engine/commands/offers.js';
import {
  normalizeFilters,
  normalizeSearchSort,
  normalizeVerifiedFilter,
  type SearchFilterSummary,
  type SearchSort,
} from './engine/commands/sourcing-utils.js';
import { offerToCanonical } from './mappers/offer-to-canonical.js';
import { searchToSourcingResult } from './mappers/search-to-sourcing-result.js';
import { imageSearchToSourcingResult } from './mappers/image-search-to-sourcing-result.js';

export interface LoginInput extends LoginOpts {}
export interface LogoutInput extends LogoutOpts {}
export interface WhoamiInput extends WhoamiArgs {}
export interface DoctorInput extends DoctorOpts {}

export interface SearchKeywordInput {
  keyword: string;
  max?: number;
  sort?: SearchSort;
  filters?: Partial<SearchFilterSummary>;
  skuMax?: number;
  profile?: string;
  headed?: boolean;
}

export interface SearchImageInput {
  imagePath: string;
  max?: number;
  profile?: string;
  headed?: boolean;
}

export interface OffersInput {
  offerIds: string[];
  profile?: string;
  headed?: boolean;
}

export interface SimilarInput {
  offerId: string;
  max?: number;
  profile?: string;
  headed?: boolean;
}

interface SkuMaxFilteredOffer {
  offerId: string;
  reason: 'SKU_COUNT_EXCEEDED';
  skuCount: number;
  skuMax: number;
}

interface SkuMaxFilteringSummary {
  skuMax: number;
  totalBeforeSkuFilter: number;
  totalAfterSkuFilter: number;
  filtered: SkuMaxFilteredOffer[];
}

export async function login1688(input: LoginInput): Promise<CommandResult<unknown>> {
  return wrapCommand('1688.login', async () => {
    await loginRun(input);
    return { ok: true };
  });
}

export async function logout1688(input: LogoutInput): Promise<CommandResult<unknown>> {
  return wrapCommand('1688.logout', async () => {
    await logoutRun(input);
    return { ok: true };
  });
}

export async function whoami1688(input: WhoamiInput): Promise<CommandResult<WhoamiResult>> {
  return wrapCommand('1688.whoami', () =>
    dispatch<WhoamiArgs, WhoamiResult>('whoami', input, { profile: input.profile }),
  );
}

export async function doctor1688(input: DoctorInput): Promise<CommandResult<unknown>> {
  return wrapCommand('1688.doctor', async () => {
    await doctorRun(input);
    return { ok: true };
  });
}

export async function search1688ByKeyword(
  input: SearchKeywordInput,
): Promise<CommandResult<SourcingResult>> {
  return wrapCommand('source.keyword', async () => {
    const keyword = input.keyword.trim();
    if (!keyword) throw new CliError(2, 'BAD_INPUT', 'Search keyword is required.');
    const max = clampPositive(input.max ?? 20, 1, 600);
    const sort = normalizeSearchSort(input.sort);
    const skuMax = normalizeSkuMax(input.skuMax);
    const filters = normalizeFilters({
      priceMin: input.filters?.priceMin ?? null,
      priceMax: input.filters?.priceMax ?? null,
      province: input.filters?.province,
      city: input.filters?.city,
      verified: normalizeVerifiedFilter(input.filters?.verified),
      minTurnover: input.filters?.minTurnover ?? null,
      excludeAds: input.filters?.excludeAds,
    });
    const search = await dispatch<SearchArgs, SearchResult>(
      'search',
      { keyword, max, sort, filters, headed: input.headed },
      { headed: input.headed, profile: input.profile },
    );
    const offerIds = search.offers
      .map((offer) => String(offer.offerId ?? '').trim())
      .filter((offerId) => /^\d+$/.test(offerId) && offerId !== '0');
    const details = await collectOffersBatch(offerIds, input);
    const result = searchToSourcingResult({ query: keyword, search, details });
    return applySkuMaxFilter(result, skuMax);
  });
}

export async function search1688ByImage(
  input: SearchImageInput,
): Promise<CommandResult<SourcingResult>> {
  return wrapCommand('source.image', async () => {
    if (!input.imagePath) throw new CliError(2, 'BAD_INPUT', 'Image path is required.');
    const max = clampPositive(input.max ?? 20, 1, 200);
    const imageSearch = await dispatch<ImageSearchArgs, ImageSearchResult>(
      'image-search',
      { imagePath: input.imagePath, max, headed: input.headed },
      { headed: input.headed, profile: input.profile },
    );
    const offerIds = imageSearch.offers.map((offer) => offer.offerId);
    const details = await collectOffersBatch(offerIds, input);
    return imageSearchToSourcingResult({ imagePath: input.imagePath, imageSearch, details });
  });
}

export async function get1688Offers(
  input: OffersInput,
): Promise<CommandResult<SourcingResult>> {
  return wrapCommand('source.offers', async () => {
    const details = await collectOffersBatch(input.offerIds, input);
    return offersToSourcingResult(details, 'offers');
  });
}

export async function get1688Similar(
  input: SimilarInput,
): Promise<CommandResult<SourcingResult>> {
  return wrapCommand('source.similar', async () => {
    if (!/^\d+$/.test(input.offerId)) {
      throw new CliError(2, 'BAD_INPUT', `Invalid offerId: ${input.offerId}`);
    }
    const max = clampPositive(input.max ?? 20, 1, 200);
    const similar = await dispatch<SimilarArgs, SimilarResult>(
      'similar',
      { offerId: input.offerId, max, headed: input.headed },
      { headed: input.headed, profile: input.profile },
    );
    const offerIds = similar.offers.map((offer) => offer.offerId);
    const details = await collectOffersBatch(offerIds, input);
    return {
      ...offersToSourcingResult(details, 'similar'),
      mode: 'similar',
      query: input.offerId,
      raw: { similar, details },
    };
  });
}

function offersToSourcingResult(
  details: OfferBatchResult,
  method: CollectionMethod,
): SourcingResult {
  return {
    mode: method === 'offers' ? 'offers' : method,
    offerIds: details.offerIds,
    total: details.total,
    success: details.success,
    failed: details.failed,
    items: details.offers.map((offer) => offerToCanonical(offer, method)),
    raw: details,
    failures: details.failures.map((failure) => ({
      offerId: failure.offerId,
      code: failure.code,
      message: failure.message,
      recoverable: failure.code !== 'BAD_INPUT',
    })),
  };
}

function applySkuMaxFilter(result: SourcingResult, skuMax?: number): SourcingResult {
  if (skuMax === undefined) return result;

  const kept: SourcingResult['items'] = [];
  const filtered: SkuMaxFilteredOffer[] = [];

  for (const item of result.items) {
    const skuCount = getSkuCount(item);
    if (skuCount <= skuMax) {
      kept.push(item);
      continue;
    }
    filtered.push({
      offerId: item.source.offerId,
      reason: 'SKU_COUNT_EXCEEDED',
      skuCount,
      skuMax,
    });
  }

  const keptOfferIds = new Set(kept.map((item) => item.source.offerId));

  return {
    ...result,
    offerIds: result.offerIds?.filter((offerId) => keptOfferIds.has(String(offerId))),
    total: kept.length + result.failed,
    success: kept.length,
    items: kept,
    raw: withSkuMaxFiltering(result.raw, {
      skuMax,
      totalBeforeSkuFilter: result.items.length,
      totalAfterSkuFilter: kept.length,
      filtered,
    }),
  };
}

function getSkuCount(item: SourcingResult['items'][number]): number {
  return item.product.skus.length > 0 ? item.product.skus.length : 1;
}

function withSkuMaxFiltering(raw: unknown, skuMaxSummary: SkuMaxFilteringSummary): unknown {
  const filtering = { skuMax: skuMaxSummary };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { originalRaw: raw, filtering };
  }

  const rawObject = raw as Record<string, unknown>;
  const existingFiltering =
    rawObject.filtering && typeof rawObject.filtering === 'object' && !Array.isArray(rawObject.filtering)
      ? (rawObject.filtering as Record<string, unknown>)
      : {};

  return {
    ...rawObject,
    filtering: {
      ...existingFiltering,
      ...filtering,
    },
  };
}

function normalizeSkuMax(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value)) throw new CliError(2, 'BAD_INPUT', '--sku-max must be a number.');
  const normalized = Math.trunc(value);
  if (normalized < 1) {
    throw new CliError(2, 'BAD_INPUT', '--sku-max must be greater than or equal to 1.');
  }
  return normalized;
}

async function wrapCommand<T>(
  command: string,
  fn: () => Promise<T>,
): Promise<CommandResult<T>> {
  try {
    const data = await fn();
    return {
      ok: true,
      command,
      data,
      warnings: [],
      errors: [],
      nextActions: [],
    };
  } catch (error) {
    const err = toErrorObject(error);
    return {
      ok: false,
      command,
      warnings: [],
      errors: [err],
      nextActions: nextActionsFor(err),
    };
  }
}

function toErrorObject(error: unknown): ErrorObject {
  const code = error instanceof CliError ? error.code : 'UNEXPECTED_ERROR';
  const risk = code === 'RISK_CONTROL' || /x5secdata|punish|captcha|verify|nocaptcha|滑块|验证码/i.test(String((error as Error)?.message ?? error));
  if (risk) {
    return {
      code: 'RISK_CONTROL',
      message: '1688 risk control or verification required. Run with --headed and complete verification manually.',
      detail: error instanceof CliError ? error.details : undefined,
      recoverable: true,
    };
  }
  return {
    code,
    message: error instanceof Error ? error.message : String(error),
    detail: error instanceof CliError ? error.details : undefined,
    recoverable: code !== 'BAD_INPUT',
  };
}

function nextActionsFor(error: ErrorObject): string[] {
  if (error.code === 'RISK_CONTROL') {
    return ['Retry with --headed and complete 1688 verification manually.'];
  }
  if (error.code === 'NOT_LOGGED_IN') return ['Run auto-ozon 1688 login.'];
  if (error.code === 'CHROMIUM_MISSING') return ['Run npx playwright install chromium.'];
  return [];
}

function clampPositive(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

export { normalizeOfferIds };
