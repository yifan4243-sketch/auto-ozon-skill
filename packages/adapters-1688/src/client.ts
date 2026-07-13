import type { CollectionMethod, CommandResult, ErrorObject } from '@auto-ozon/contracts';
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
  type OfferArgs,
  type OfferBatchResult,
  type OfferFailure,
  type OfferResult,
} from './engine/commands/offers.js';
import {
  normalizeFilters,
  normalizeSearchSort,
  type SearchFilterSummary,
  type SearchSort,
} from './engine/commands/sourcing-utils.js';

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

export interface CollectedSourcingRun {
  mode: CollectionMethod;
  query: string | null;
  imagePath: string | null;
  details: OfferBatchResult;
  filtering?: Record<string, unknown>;
}

interface SkuMaxFilteredOffer {
  offerId: string;
  reason: 'SKU_COUNT_EXCEEDED';
  skuCount: number;
  skuMax: number;
}

type SkuMaxStopReason = 'TARGET_REACHED' | 'CANDIDATE_EXHAUSTED';

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

export async function collectKeywordSource(
  input: SearchKeywordInput,
): Promise<CollectedSourcingRun> {
  const keyword = input.keyword.trim();
  if (!keyword) throw new CliError(2, 'BAD_INPUT', 'Search keyword is required.');
  const targetMax = clampPositive(input.max ?? 20, 1, 600);
  const sort = normalizeSearchSort(input.sort);
  const skuMax = normalizeSkuMax(input.skuMax);
  const candidateMax =
    skuMax === undefined ? targetMax : calculateSkuMaxCandidateMax(targetMax);
  const filters = normalizeFilters({
    priceMin: input.filters?.priceMin ?? null,
    priceMax: input.filters?.priceMax ?? null,
  });
  const search = await dispatch<SearchArgs, SearchResult>(
    'search',
    { keyword, max: candidateMax, sort, filters, headed: input.headed },
    { headed: input.headed, profile: input.profile },
  );
  const offerIds = normalizeOfferIds(
    search.offers
      .map((offer) => String(offer.offerId ?? '').trim())
      .filter((offerId) => /^\d+$/.test(offerId) && offerId !== '0'),
  );

  if (skuMax !== undefined) {
    return collectKeywordOffersUntilSkuTarget({
      query: keyword,
      offerIds,
      profile: input.profile,
      headed: input.headed,
      skuMax,
      targetMax,
      candidateMax,
    });
  }

  const details = await collectOffersBatch(offerIds, input);
  return {
    mode: 'keyword',
    query: keyword,
    imagePath: null,
    details,
  };
}

export async function collectImageSource(input: SearchImageInput): Promise<CollectedSourcingRun> {
  if (!input.imagePath) throw new CliError(2, 'BAD_INPUT', 'Image path is required.');
  const max = clampPositive(input.max ?? 20, 1, 200);
  const imageSearch = await dispatch<ImageSearchArgs, ImageSearchResult>(
    'image-search',
    { imagePath: input.imagePath, max, headed: input.headed },
    { headed: input.headed, profile: input.profile },
  );
  const details = await collectOffersBatch(
    imageSearch.offers.map((offer) => offer.offerId),
    input,
  );
  return {
    mode: 'image',
    query: null,
    imagePath: input.imagePath,
    details,
  };
}

export async function collectOffersSource(input: OffersInput): Promise<CollectedSourcingRun> {
  const details = await collectOffersBatch(input.offerIds, input);
  return {
    mode: 'offers',
    query: null,
    imagePath: null,
    details,
  };
}

export async function collectSimilarSource(input: SimilarInput): Promise<CollectedSourcingRun> {
  if (!/^\d+$/.test(input.offerId)) {
    throw new CliError(2, 'BAD_INPUT', `Invalid offerId: ${input.offerId}`);
  }
  const max = clampPositive(input.max ?? 20, 1, 200);
  const similar = await dispatch<SimilarArgs, SimilarResult>(
    'similar',
    { offerId: input.offerId, max, headed: input.headed },
    { headed: input.headed, profile: input.profile },
  );
  const details = await collectOffersBatch(
    similar.offers.map((offer) => offer.offerId),
    input,
  );
  return {
    mode: 'similar',
    query: input.offerId,
    imagePath: null,
    details,
  };
}

async function collectKeywordOffersUntilSkuTarget(input: {
  query: string;
  offerIds: string[];
  profile?: string;
  headed?: boolean;
  skuMax: number;
  targetMax: number;
  candidateMax: number;
}): Promise<CollectedSourcingRun> {
  const candidateOfferIds = input.offerIds.slice(0, input.candidateMax);
  const checkedOfferIds: string[] = [];
  const collectedOffers: OfferResult[] = [];
  const selectedOffers: OfferResult[] = [];
  const filtered: SkuMaxFilteredOffer[] = [];
  const failures: OfferFailure[] = [];

  for (
    let i = 0;
    i < candidateOfferIds.length && selectedOffers.length < input.targetMax;
    i++
  ) {
    const offerId = candidateOfferIds[i]!;
    checkedOfferIds.push(offerId);

    if (!/^\d+$/.test(offerId)) {
      failures.push({ offerId, code: 'BAD_INPUT', message: 'Invalid offerId' });
      continue;
    }

    process.stderr.write(`[${i + 1}/${candidateOfferIds.length}] collecting offerId ${offerId}\n`);

    try {
      const offer = await dispatch<OfferArgs, OfferResult>(
        'offers',
        { offerId, headed: input.headed },
        { headed: input.headed, profile: input.profile },
      );
      collectedOffers.push(offer);

      const skuCount = normalizedOfferSkuCount(offer);
      if (skuCount > input.skuMax) {
        filtered.push({
          offerId: offer.offerId,
          reason: 'SKU_COUNT_EXCEEDED',
          skuCount,
          skuMax: input.skuMax,
        });
        continue;
      }

      selectedOffers.push(offer);
    } catch (error) {
      if (isTerminalOfferError(error)) throw error;
      failures.push(toOfferFailure(offerId, error));
    }
  }

  const stopReason: SkuMaxStopReason =
    selectedOffers.length >= input.targetMax
      ? 'TARGET_REACHED'
      : 'CANDIDATE_EXHAUSTED';
  const selectedDetails: OfferBatchResult = {
    mode: 'offers',
    total: checkedOfferIds.length,
    success: selectedOffers.length,
    failed: failures.length,
    offerIds: selectedOffers.map((offer) => offer.offerId),
    offers: selectedOffers,
    failures,
  };

  return {
    mode: 'keyword',
    query: input.query,
    imagePath: null,
    details: selectedDetails,
    filtering: {
      skuMax: {
        skuMax: input.skuMax,
        targetMax: input.targetMax,
        candidateMax: input.candidateMax,
        checkedCandidates: checkedOfferIds.length,
        stoppedEarly: stopReason === 'TARGET_REACHED' && checkedOfferIds.length < candidateOfferIds.length,
        stopReason,
        totalBeforeSkuFilter: collectedOffers.length,
        totalEligibleBeforeTargetLimit: selectedOffers.length,
        totalAfterSkuFilter: selectedOffers.length,
        filtered,
      },
    },
  };
}

function normalizedOfferSkuCount(offer: OfferResult): number {
  return offer.skus.length > 0 ? offer.skus.length : 1;
}

function normalizeSkuMax(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1) {
    throw new CliError(2, 'BAD_INPUT', '--sku-max must be a positive integer.');
  }
  return value;
}

function calculateSkuMaxCandidateMax(targetMax: number): number {
  return clampPositive(targetMax * 10, targetMax, 600);
}

function toOfferFailure(offerId: string, error: unknown): OfferFailure {
  const err = error as Error & { code?: string };
  return {
    offerId,
    code: err.code || 'DEEP_COLLECT_FAILED',
    message: sanitiseDeepCollectMessage(err.message || String(error)),
  };
}

function sanitiseDeepCollectMessage(message: string): string {
  if (/x5secdata|punish|captcha|verify|nocaptcha/i.test(message)) {
    return '1688 触发滑块验证，请使用 --headed 手动处理。';
  }
  return message;
}

const TERMINAL_OFFER_ERROR_CODES = new Set([
  'BROWSER_CONTEXT_BROKEN',
  'CANCELED',
  'CHROMIUM_MISSING',
  'LOCK_BUSY',
  'NOT_LOGGED_IN',
  'RATE_LIMITED',
  'RISK_CONTROL',
  'SITE_CHANGED',
]);

function isTerminalOfferError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'string' && TERMINAL_OFFER_ERROR_CODES.has(code)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /x5secdata|punish|captcha|verify|nocaptcha|滑块|验证码/i.test(message);
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
