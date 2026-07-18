import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildProgram } from '../../../apps/cli/src/cli.js';
import type { OfferResult, OfferBatchResult } from '../../../packages/adapters-1688/src/engine/commands/offers.js';
import { collectOffersBatch, normalizeOfferIds } from '../../../packages/adapters-1688/src/engine/commands/offers.js';
import { get1688Offers } from '../../helpers/source-api.js';
import { offerToCanonical } from '../../../packages/steps/canonicalize-product/src/offer-to-canonical.js';
import { collectedRunToV1 } from '../../../packages/steps/canonicalize-product/src/sourcing-runtime.js';

describe('1688 offers batching', () => {
  it('deduplicates offer ids while preserving input order', () => {
    expect(normalizeOfferIds(['123', '123', ' 456 ', '', 'bad-id', '456'])).toEqual([
      '123',
      '456',
      'bad-id',
    ]);
  });

  it('returns unified offers shape for invalid ids without opening a browser', async () => {
    const result = await collectOffersBatch(['bad-id']);
    expect(result).toMatchObject({
      mode: 'offers',
      total: 1,
      success: 0,
      failed: 1,
      offerIds: ['bad-id'],
      offers: [],
      failures: [{ offerId: 'bad-id', code: 'BAD_INPUT', message: 'Invalid offerId' }],
    });
  });
});

describe('1688 mappers', () => {
  it('maps OfferResult to CanonicalProduct', () => {
    const offer = readFixture<OfferResult>('offer-result.json');
    const canonical = offerToCanonical(offer, 'offers', '2026-07-09T00:00:00.000Z');
    expect(canonical.source).toEqual({
      platform: '1688',
      offerId: '123456789',
      offerUrl: 'https://detail.1688.com/offer/123456789.html',
      collectedAt: '2026-07-09T00:00:00.000Z',
      collectionMethod: 'offers',
      sourceCategoryPathZh: ['家居百货', '收纳整理', '收纳箱'],
    });
    expect(canonical.product.chineseTitle).toContain('收纳盒');
    expect(canonical.product.priceTiers[0]).toEqual({ minQty: 2, priceCny: 4.5 });
    expect(canonical.product.skus[0]?.attributes).toEqual({ 颜色: '透明' });
    expect(canonical).not.toHaveProperty('supplier');
    expect(canonical.product.skus[0]).not.toHaveProperty('stock');
    expect(canonical.validation.status).toBe('valid');
  });

  it('maps search results plus details to SourcingResult', () => {
    const offer = readFixture<OfferResult>('offer-result.json');
    const details = makeDetails([offer]);
    const result = collectedRunToV1({
      mode: 'keyword',
      query: '收纳盒',
      imagePath: null,
      details,
    });
    expect(result.mode).toBe('keyword');
    expect(result.total).toBe(1);
    expect(result.items[0]?.source.collectionMethod).toBe('keyword');
    expect(result.raw).toMatchObject({ mode: 'offers', offers: [{ offerId: offer.offerId }] });
  });

  it('maps image search candidates plus details to SourcingResult', () => {
    const offer = readFixture<OfferResult>('offer-result.json');
    const details = makeDetails([offer]);
    const result = collectedRunToV1({
      mode: 'image',
      query: null,
      imagePath: 'tests/fixtures/1688/product.jpg',
      details,
    });
    expect(result.mode).toBe('image');
    expect(result.imagePath).toContain('product.jpg');
    expect(result.items[0]?.source.collectionMethod).toBe('image');
  });
});

describe('CLI registration', () => {
  it('does not expose background-process commands in help', () => {
    const help = collectHelp(buildProgram());
    expect(help.toLowerCase()).not.toContain('daemon');
  });

  it('does not register dropped command groups', () => {
    const program = buildProgram();
    expect(program.commands.map((command) => command.name())).toEqual(['1688', 'source', 'ozon', 'setup', 'review-console', 'workflow']);
    const dropped = ['serve', 'research', 'compare', 'supplier', 'cart', 'checkout', 'order', 'seller', 'feedback'];
    for (const name of dropped) {
      expect(findCommand(program, name)).toBeUndefined();
    }
  });

  it('does not expose search controls that require discarded supplier or sales facts', () => {
    const keyword = findCommand(buildProgram(), 'keyword');
    expect(keyword).toBeDefined();
    const help = keyword!.helpInformation();
    for (const removed of [
      '--province',
      '--city',
      '--verified',
      '--min-turnover',
      '--exclude-ads',
      'best-selling',
    ]) {
      expect(help).not.toContain(removed);
    }
  });
});

describe('CommandResult', () => {
  it('returns a stable CommandResult shape for partial offers failure', async () => {
    const result = await get1688Offers({ offerIds: ['bad-id'] });
    expect(result).toMatchObject({
      ok: true,
      command: 'source.offers',
      warnings: [],
      errors: [],
      nextActions: [],
      data: {
        mode: 'offers',
        total: 1,
        success: 0,
        failed: 1,
      },
    });
  });
});

function readFixture<T>(name: string): T {
  return JSON.parse(
    fs.readFileSync(new URL(`../../fixtures/1688/${name}`, import.meta.url), 'utf8'),
  ) as T;
}

function makeDetails(offers: OfferResult[]): OfferBatchResult {
  return {
    mode: 'offers',
    total: offers.length,
    success: offers.length,
    failed: 0,
    offerIds: offers.map((offer) => offer.offerId),
    offers,
    failures: [],
  };
}

function collectHelp(command: import('commander').Command): string {
  return [command.helpInformation(), ...command.commands.map(collectHelp)].join('\n');
}

function findCommand(command: import('commander').Command, name: string): import('commander').Command | undefined {
  for (const child of command.commands) {
    if (child.name() === name) return child;
    const nested = findCommand(child, name);
    if (nested) return nested;
  }
  return undefined;
}
