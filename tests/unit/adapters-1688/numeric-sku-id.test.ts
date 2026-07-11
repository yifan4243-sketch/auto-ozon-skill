import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseOfferResult } from '../../../packages/adapters-1688/src/v2/offer-result-codec.js';

describe('1688 numeric SKU identifier compatibility', () => {
  it('normalizes numeric SKU and package identifiers to strings', () => {
    const fixture = JSON.parse(
      fs.readFileSync(
        new URL('../../fixtures/1688/offer-result.json', import.meta.url),
        'utf8',
      ),
    ) as {
      skus: Array<{ skuId: string | number }>;
      packageInfo: Array<{ skuId: string | number }>;
    };

    fixture.skus[0]!.skuId = 4958524658555;
    fixture.packageInfo[0]!.skuId = 4958524658555;

    const parsed = parseOfferResult(fixture);

    expect(parsed.skus[0]!.skuId).toBe('4958524658555');
    expect(parsed.packageInfo[0]!.skuId).toBe('4958524658555');
  });
});
