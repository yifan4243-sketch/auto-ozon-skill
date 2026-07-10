import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OfferResult } from '../../../packages/adapters-1688/src/engine/commands/offers.js';
import type { SearchResult } from '../../../packages/adapters-1688/src/engine/commands/search.js';
import { CliError } from '../../../packages/adapters-1688/src/engine/io/errors.js';

const dispatchMock = vi.hoisted(() => vi.fn());

vi.mock('../../../packages/adapters-1688/src/engine/session/dispatch.js', () => ({
  dispatch: dispatchMock,
}));

import { buildProgram } from '../../../apps/cli/src/cli.js';
import { search1688ByKeyword } from '../../../packages/adapters-1688/src/client.js';

describe('keyword SKU filtering', () => {
  beforeEach(() => {
    dispatchMock.mockReset();
  });

  it('filters over-limit offers, treats no-SKU products as one, and stops at the target', async () => {
    const search = makeSearch(['1001', '1001', '1002', '1003', '1004']);
    const offers = new Map([
      ['1001', makeOffer('1001', 3)],
      ['1002', makeOffer('1002', 0)],
      ['1003', makeOffer('1003', 2)],
      ['1004', makeOffer('1004', 1)],
    ]);
    mockSearchAndOffers(search, offers);

    const result = await search1688ByKeyword({ keyword: '测试', max: 2, skuMax: 2 });

    expect(result.ok).toBe(true);
    expect(result.data?.offerIds).toEqual(['1002', '1003']);
    expect(result.data).toMatchObject({ total: 3, success: 2, failed: 0 });
    expect(offerDispatchIds()).toEqual(['1001', '1002', '1003']);
    expect(result.data?.raw).toMatchObject({
      filtering: {
        skuMax: {
          skuMax: 2,
          targetMax: 2,
          candidateMax: 20,
          checkedCandidates: 3,
          stoppedEarly: true,
          stopReason: 'TARGET_REACHED',
          totalBeforeSkuFilter: 3,
          totalAfterSkuFilter: 2,
          filtered: [
            { offerId: '1001', reason: 'SKU_COUNT_EXCEEDED', skuCount: 3, skuMax: 2 },
          ],
        },
      },
    });
  });

  it('stops immediately on a session-level error instead of retrying every candidate', async () => {
    const search = makeSearch(['2001', '2002', '2003']);
    dispatchMock.mockImplementation(async (name: string, args: { offerId?: string }) => {
      if (name === 'search') return search;
      if (args.offerId === '2001') return makeOffer('2001', 1);
      if (args.offerId === '2002') throw new CliError(4, 'RISK_CONTROL', 'captcha required');
      return makeOffer(String(args.offerId), 1);
    });

    const result = await search1688ByKeyword({ keyword: '测试', max: 3, skuMax: 2 });

    expect(result).toMatchObject({
      ok: false,
      command: 'source.keyword',
      errors: [{ code: 'RISK_CONTROL', recoverable: true }],
    });
    expect(offerDispatchIds()).toEqual(['2001', '2002']);
  });

  it('keeps the legacy keyword path when skuMax is omitted', async () => {
    const search = makeSearch(['3001', '3002']);
    mockSearchAndOffers(
      search,
      new Map([
        ['3001', makeOffer('3001', 4)],
        ['3002', makeOffer('3002', 1)],
      ]),
    );

    const result = await search1688ByKeyword({ keyword: '测试', max: 2 });

    expect(result.ok).toBe(true);
    expect(result.data?.offerIds).toEqual(['3001', '3002']);
    expect(result.data?.items).toHaveLength(2);
    expect(result.data?.raw).not.toHaveProperty('filtering');
  });

  it('rejects invalid CLI values before starting collection', async () => {
    const program = buildProgram();

    await expect(
      program.parseAsync(['node', 'auto-ozon', 'source', 'keyword', '测试', '--sku-max', 'abc']),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('rejects fractional programmatic values', async () => {
    const result = await search1688ByKeyword({ keyword: '测试', skuMax: 2.5 });

    expect(result).toMatchObject({
      ok: false,
      errors: [{ code: 'BAD_INPUT', message: '--sku-max must be a positive integer.' }],
    });
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});

function mockSearchAndOffers(search: SearchResult, offers: Map<string, OfferResult>): void {
  dispatchMock.mockImplementation(async (name: string, args: { offerId?: string }) => {
    if (name === 'search') return search;
    const offer = offers.get(String(args.offerId));
    if (!offer) throw new Error(`Missing test offer ${args.offerId}`);
    return offer;
  });
}

function offerDispatchIds(): string[] {
  return dispatchMock.mock.calls
    .filter(([name]) => name === 'offers')
    .map(([, args]) => String((args as { offerId: string }).offerId));
}

function makeSearch(offerIds: string[]): SearchResult {
  const fixture = readFixture<SearchResult>('search-result-with-details.json');
  const template = fixture.offers[0]!;
  return {
    ...fixture,
    totalBeforeFilter: offerIds.length,
    total: offerIds.length,
    offers: offerIds.map((offerId) => ({
      ...template,
      offerId,
      url: `https://detail.1688.com/offer/${offerId}.html`,
    })),
  };
}

function makeOffer(offerId: string, skuCount: number): OfferResult {
  const fixture = readFixture<OfferResult>('offer-result.json');
  const sku = fixture.skus[0]!;
  return {
    ...fixture,
    offerId,
    url: `https://detail.1688.com/offer/${offerId}.html`,
    skus: Array.from({ length: skuCount }, (_, index) => ({
      ...sku,
      skuId: `${offerId}-${index + 1}`,
    })),
  };
}

function readFixture<T>(name: string): T {
  return JSON.parse(
    fs.readFileSync(new URL(`../../fixtures/1688/${name}`, import.meta.url), 'utf8'),
  ) as T;
}
