import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult } from '../../../packages/contracts/src/command-result.js';
import type { SourcingResultV2 } from '../../../packages/contracts/src/sourcing-result-v2.js';
import type { OfferResult } from '../../../packages/adapters-1688/src/engine/commands/offers.js';
import type { SearchResult } from '../../../packages/adapters-1688/src/engine/commands/search.js';
import type { ImageSearchResult } from '../../../packages/adapters-1688/src/engine/commands/image-search.js';
import type { SimilarResult } from '../../../packages/adapters-1688/src/engine/commands/similar.js';

const dispatchMock = vi.hoisted(() => vi.fn());

vi.mock('../../../packages/adapters-1688/src/engine/session/dispatch.js', () => ({
  dispatch: dispatchMock,
}));

import {
  buildProgram,
  formatCanonicalV2HumanSummary,
  parseSchemaVersion,
} from '../../../apps/cli/src/cli.js';
import {
  get1688Offers,
  get1688OffersV2,
  get1688Similar,
  get1688SimilarV2,
  search1688ByImage,
  search1688ByImageV2,
  search1688ByKeyword,
  search1688ByKeywordV2,
} from '../../../packages/adapters-1688/src/client.js';

describe('CanonicalProductV2 sourcing runtime', () => {
  beforeEach(() => {
    dispatchMock.mockReset();
    mockSuccessfulCollection();
    process.exitCode = undefined;
  });

  it('keeps all four public source APIs on V1 by default', async () => {
    const results = await Promise.all([
      search1688ByKeyword({ keyword: '修枝剪', max: 1 }),
      search1688ByImage({ imagePath: 'C:\\private\\product.jpg', max: 1 }),
      get1688Offers({ offerIds: ['123456789'] }),
      get1688Similar({ offerId: '999999999', max: 1 }),
    ]);

    for (const result of results) {
      expect(result.ok).toBe(true);
      expect(result.data?.items[0]).toHaveProperty('source.offerId', '123456789');
      expect(result.data).not.toHaveProperty('schema_version');
    }
  });

  it('maps all four source APIs to V2 with correct methods and context', async () => {
    const keyword = dataOf(
      await search1688ByKeywordV2({ keyword: '修枝剪', max: 1 }),
    );
    const image = dataOf(
      await search1688ByImageV2({
        imagePath: 'C:\\Users\\secret\\product.jpg',
        max: 1,
      }),
    );
    const offers = dataOf(await get1688OffersV2({ offerIds: ['123456789'] }));
    const similar = dataOf(
      await get1688SimilarV2({ offerId: '999999999', max: 1 }),
    );

    expect(keyword.mode).toBe('keyword');
    expect(keyword.items[0]!.source).toMatchObject({
      collection_method: 'keyword',
      discovery_context: { search_term: '修枝剪', seed_offer_id: null },
    });
    expect(image.items[0]!.source).toMatchObject({
      collection_method: 'image',
      discovery_context: { search_term: null, seed_offer_id: null },
    });
    expect(JSON.stringify(image)).not.toContain('C:\\Users\\secret');
    expect(offers.items[0]!.source).toMatchObject({
      collection_method: 'offers',
      discovery_context: { search_term: null, seed_offer_id: null },
    });
    expect(similar.items[0]!.source).toMatchObject({
      collection_method: 'similar',
      discovery_context: { search_term: null, seed_offer_id: '999999999' },
    });
  });

  it('preserves the same keyword search term on every product in a batch', async () => {
    const search = readFixture<SearchResult>('search-result-with-details.json');
    search.offers = [
      search.offers[0]!,
      { ...search.offers[0]!, offerId: '123456790' },
    ];
    search.total = 2;
    search.totalBeforeFilter = 2;
    const offer = readFixture<OfferResult>('offer-result.json');
    dispatchMock.mockImplementation(async (name: string, args: { offerId?: string }) => {
      if (name === 'search') return structuredClone(search);
      if (name === 'offers') {
        return { ...structuredClone(offer), offerId: String(args.offerId) };
      }
      throw new Error(`Unexpected dispatch ${name}`);
    });

    const result = await search1688ByKeywordV2({ keyword: '修枝剪', max: 2 });

    expect(result.data?.items).toHaveLength(2);
    expect(
      result.data?.items.every(
        (item) => item.source.discovery_context.search_term === '修枝剪',
      ),
    ).toBe(true);
  });

  it('preserves blocked products and collection failures in V2', async () => {
    const invalidSkuOffer = readFixture<OfferResult>('offer-result.json');
    invalidSkuOffer.skus[0]!.skuId = '';
    dispatchMock.mockImplementation(async (name: string, args: { offerId?: string }) => {
      if (name === 'offers') return structuredClone(invalidSkuOffer);
      throw new Error(`Unexpected dispatch ${name} ${String(args.offerId)}`);
    });

    const result = await get1688OffersV2({
      offerIds: ['123456789', 'bad-id'],
    });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ total: 2, success: 1, failed: 1 });
    expect(result.data?.items).toHaveLength(1);
    expect(result.data?.items[0]!.validation.status).toBe('blocked');
    expect(result.data?.failures).toEqual([
      {
        offer_id: 'bad-id',
        code: 'BAD_INPUT',
        message: 'Invalid offerId',
        recoverable: false,
      },
    ]);
  });

  it('returns a failed command result when every detail collection fails', async () => {
    const result = await get1688OffersV2({ offerIds: ['bad-id'] });

    expect(result).toMatchObject({
      ok: false,
      data: { total: 1, success: 0, failed: 1, items: [] },
      errors: [
        {
          code: 'SOURCE_COLLECTION_FAILED',
          recoverable: false,
        },
      ],
    });
    expect(result.errors[0]!.detail).toEqual(result.data?.failures);
  });

  it('preserves needs_review products instead of filtering them', async () => {
    const offer = readFixture<OfferResult>('offer-result.json');
    const sourceSku = offer.skus[0]!;
    offer.skus = [
      { ...sourceSku, skuId: 'duplicate-spec-a' },
      { ...sourceSku, skuId: 'duplicate-spec-b' },
    ];
    offer.packageInfo = [];
    dispatchMock.mockImplementation(async (name: string) => {
      if (name === 'offers') return structuredClone(offer);
      throw new Error(`Unexpected dispatch ${name}`);
    });

    const result = await get1688OffersV2({ offerIds: [offer.offerId] });

    expect(result.ok).toBe(true);
    expect(result.data?.items).toHaveLength(1);
    expect(result.data?.items[0]!.validation.status).toBe('needs_review');
  });

  it('rejects every invalid schema version before collection', async () => {
    for (const value of ['0', '3', 'abc', '2.5']) {
      dispatchMock.mockClear();
      await expect(
        buildProgram().parseAsync([
          'node',
          'auto-ozon',
          'source',
          'offers',
          '123456789',
          '--schema-version',
          value,
        ]),
      ).rejects.toMatchObject({ code: 'BAD_INPUT' });
      expect(dispatchMock).not.toHaveBeenCalled();
    }
    expect(parseSchemaVersion(undefined)).toBe(1);
    expect(parseSchemaVersion('1')).toBe(1);
    expect(parseSchemaVersion('2')).toBe(2);
  });

  it('rejects --save-dir on the V1 collection path before collection', async () => {
    await expect(
      buildProgram().parseAsync([
        'node',
        'auto-ozon',
        'source',
        'offers',
        '123456789',
        '--save-dir',
        'tmp/run',
      ]),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('keeps --json-v2 independent from --schema-version 2', async () => {
    let stdout = '';
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk) => {
        stdout += String(chunk);
        return true;
      });
    try {
      await buildProgram().parseAsync([
        'node',
        'auto-ozon',
        'source',
        'offers',
        '123456789',
        '--schema-version',
        '2',
        '--json-v2',
        '--pretty',
      ]);
    } finally {
      write.mockRestore();
    }

    const envelope = JSON.parse(stdout) as {
      data: CommandResult<SourcingResultV2>;
    };
    expect(envelope.data.command).toBe('source.offers');
    expect(envelope.data.data?.schema_version).toBe(2);
    expect(envelope.data.data?.items[0]!.schema_version).toBe(2);
  });

  it('wires schema version selection through every CLI source command', async () => {
    const commands = [
      ['source', 'keyword', '修枝剪', '--max', '1'],
      ['source', 'image', 'C:\\private\\product.jpg', '--max', '1'],
      ['source', 'offers', '123456789'],
      ['source', 'similar', '999999999', '--max', '1'],
    ];

    for (const args of commands) {
      dispatchMock.mockReset();
      mockSuccessfulCollection();
      const v1 = await captureCliJson([...args, '--json']);
      expect(v1.data).not.toHaveProperty('schema_version');
      expect(v1.data.items[0]).toHaveProperty('source.offerId');

      dispatchMock.mockReset();
      mockSuccessfulCollection();
      const v2 = await captureCliJson([
        ...args,
        '--schema-version',
        '2',
        '--json',
      ]);
      expect(v2.data.schema_version).toBe(2);
      expect(v2.data.items[0]).toHaveProperty('source.offer_id');
    }
  });

  it('renders a concise human summary instead of full V2 JSON', async () => {
    const result = await get1688OffersV2({ offerIds: ['123456789'] });
    const summary = formatCanonicalV2HumanSummary(result, result.data!);

    expect(summary).toContain('source.offers: 1/1 collected');
    expect(summary).toContain('schema: CanonicalProductV2');
    expect(summary).toContain('products: 1');
    expect(summary).toContain('status: valid=');
    expect(summary).toContain('package matches:');
    expect(summary).toContain('integrity: pass');
    expect(summary).not.toContain('gallery_images');
  });
});

function dataOf(result: CommandResult<SourcingResultV2>): SourcingResultV2 {
  expect(result.ok).toBe(true);
  expect(result.data?.integrity_report.status).toBe('pass');
  return result.data!;
}

function mockSuccessfulCollection(): void {
  const offer = readFixture<OfferResult>('offer-result.json');
  const search = readFixture<SearchResult>('search-result-with-details.json');
  const image = readFixture<ImageSearchResult>('image-search-result.json');
  const similar: SimilarResult = {
    offerId: '999999999',
    total: search.offers.length,
    offers: search.offers,
  };

  dispatchMock.mockImplementation(async (name: string, args: { offerId?: string }) => {
    if (name === 'search') return structuredClone(search);
    if (name === 'image-search') return structuredClone(image);
    if (name === 'similar') return structuredClone(similar);
    if (name === 'offers') {
      return {
        ...structuredClone(offer),
        offerId: String(args.offerId),
        url: `https://detail.1688.com/offer/${String(args.offerId)}.html`,
      };
    }
    throw new Error(`Unexpected dispatch ${name}`);
  });
}

function readFixture<T>(name: string): T {
  return JSON.parse(
    fs.readFileSync(new URL(`../../fixtures/1688/${name}`, import.meta.url), 'utf8'),
  ) as T;
}

async function captureCliJson(args: string[]): Promise<{
  data: Record<string, unknown> & { items: unknown[] };
}> {
  let stdout = '';
  const write = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });
  try {
    await buildProgram().parseAsync(['node', 'auto-ozon', ...args]);
  } finally {
    write.mockRestore();
  }
  return JSON.parse(stdout) as {
    data: Record<string, unknown> & { items: unknown[] };
  };
}
