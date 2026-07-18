import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  CanonicalProductV2,
  CategoryDecisionV1,
  CostPricingCommissionSnapshotV1,
  CostPricingFxRateV1,
} from '../../../../packages/contracts/src/index.js';
import {
  calculateCelCandidates,
  CbrFxRateProvider,
  loadCelTariffSnapshot,
  priceFitsCelBand,
  resolveCommissionSnapshot,
  runCostPricing,
} from '../../../../packages/steps/cost-pricing/src/index.js';

afterEach(() => vi.unstubAllGlobals());

describe('CEL tariff V1', () => {
  it('loads and verifies the versioned manual snapshot without inventing validity dates', () => {
    const snapshot = loadCelTariffSnapshot();
    expect(snapshot).toMatchObject({
      provider_id: 'cel', snapshot_id: 'CEL-2026-effective', currency: 'CNY',
      source: { kind: 'legacy_manual_snapshot', verification_status: 'needs_review' },
      captured_at: null, valid_from: null, valid_to: null,
    });
    expect(snapshot.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(snapshot.rules).toHaveLength(6);
  });

  it('uses the effective land rates and exact weight boundaries', () => {
    expect(candidates(500).map((item) => item.name)).toContain('Extra Small');
    expect(candidates(501).map((item) => item.name)).toContain('Budget');
    expect(candidates(2000).map((item) => item.name)).toContain('Small');
    expect(candidates(2001).map((item) => item.name)).toContain('Big');
    expect(candidates(5000).map((item) => item.name)).toContain('Premium Small');
    expect(candidates(5001).map((item) => item.name)).toContain('Premium Big');

    const extraSmall = candidates(100).find((item) => item.name === 'Extra Small')!;
    expect(extraSmall).toMatchObject({ rate_per_g_cny: 0.026, fixed_fee_cny: 3.12, shipping_cny: 5.72 });
  });

  it('charges Big by the greater of actual and volumetric weight', () => {
    const big = calculateCelCandidates({
      actual_weight_kg: 3,
      volume_weight_kg: 5,
      length_cm: 50,
      width_cm: 40,
      height_cm: 30,
    }, 'land').find((item) => item.name === 'Big')!;
    expect(big.charge_weight_g).toBe(5000);
    expect(big.shipping_cny).toBe(125.84);
  });

  it('enforces Premium Big dimensions and volumetric ceiling', () => {
    expect(candidates(6000, 150, 80, 80).some((item) => item.name === 'Premium Big')).toBe(true);
    expect(candidates(6000, 150, 81, 79).some((item) => item.name === 'Premium Big')).toBe(false);
    expect(candidates(6000, 150, 80, 80.01).some((item) => item.name === 'Premium Big')).toBe(false);
  });

  it('enforces the documented weight and dimension boundaries exactly', () => {
    expect(candidates(30_000).length).toBeGreaterThan(0);
    expect(candidates(30_001)).toEqual([]);

    expect(candidates(500, 60, 20, 10).some((item) => item.name === 'Extra Small')).toBe(true);
    expect(candidates(500, 60.01, 19.99, 10).some((item) => item.name === 'Extra Small')).toBe(false);

    expect(candidates(501, 60, 50, 40).some((item) => item.name === 'Budget')).toBe(true);
    expect(candidates(501, 60, 50, 40.01).some((item) => item.name === 'Budget')).toBe(false);

    const bigAtLimit = calculateCelCandidates({
      actual_weight_kg: 3, volume_weight_kg: 18.75,
      length_cm: 150, width_cm: 150, height_cm: 10,
    }, 'land');
    const bigOverLimit = calculateCelCandidates({
      actual_weight_kg: 3, volume_weight_kg: 18.75,
      length_cm: 150, width_cm: 150, height_cm: 10.01,
    }, 'land');
    expect(bigAtLimit.some((item) => item.name === 'Big')).toBe(true);
    expect(bigOverLimit.some((item) => item.name === 'Big')).toBe(false);
  });

  it('uses inclusive and exclusive RUB price-band edges without overlap', () => {
    const extraSmall = candidates(100).find((item) => item.name === 'Extra Small')!;
    const small = candidates(100).find((item) => item.name === 'Small')!;
    const premiumSmall = candidates(100).find((item) => item.name === 'Premium Small')!;

    expect(priceFitsCelBand(1, extraSmall)).toBe(true);
    expect(priceFitsCelBand(1500, extraSmall)).toBe(true);
    expect(priceFitsCelBand(1500, small)).toBe(false);
    expect(priceFitsCelBand(1500.01, small)).toBe(true);
    expect(priceFitsCelBand(7000, small)).toBe(true);
    expect(priceFitsCelBand(7000, premiumSmall)).toBe(false);
    expect(priceFitsCelBand(7000.01, premiumSmall)).toBe(true);
  });
});

describe('commission and exchange rate inputs', () => {
  it('normalizes the supplied hierarchical commission shape', () => {
    const snapshot = resolveCommissionSnapshot({ data: [{
      label: '住宅和花园',
      children: [{
        label: '一次性餐具', cate_id: 92417201, children: [
          { label: '售价 ≤ 1500₽ (12.00%)', value: '1,12.00' },
          { label: '1500₽ < 售价 ≤ 5000₽ (18.00%)', value: '2,18.00' },
          { label: '售价 > 5000₽ (18.00%)', value: '3,18.00' },
        ],
      }],
    }] });
    expect(snapshot.categories[0]).toMatchObject({
      category_id: 92417201,
      tiers: [
        { price_max_rub: 1500, rate_percent: 12 },
        { price_min_rub: 1500, price_max_rub: 5000, rate_percent: 18 },
        { price_min_rub: 5000, price_max_rub: null, rate_percent: 18 },
      ],
    });
  });

  it('parses CNY nominal and RUB value from the official CBR XML', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      '<ValCurs Date="15.07.2026"><Valute><NumCode>156</NumCode><CharCode>CNY</CharCode><Nominal>1</Nominal><Name>Юань</Name><Value>11,2500</Value></Valute></ValCurs>',
      { status: 200 },
    )));
    await expect(new CbrFxRateProvider().getCnyRub()).resolves.toMatchObject({
      rub_per_cny: 11.25,
      published_at: '2026-07-15T00:00:00.000Z',
      cache_status: 'live',
    });
  });
});

describe('cost pricing service', () => {
  it('calculates cost x2, commission, other-rate cost and profit', async () => {
    const result = await runCostPricing({
      product: product(), category_decision: decision(), fx_rate: fx(), commission_snapshot: commission(),
    });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      status: 'completed',
      sku_pricing: [{
        cel_group: 'Extra Small',
        purchase_cost_cny: 10,
        cel_shipping_cny: 5.72,
        landed_cost_cny: 17.72,
        final_price_cny: 35,
        final_price_rub: 350,
        commission: { rate_percent: 12 },
        commission_amount_cny: 4.2,
        other_rate_amount_cny: 3.5,
        estimated_profit_cny: 9.58,
        weight_facts: {
          semantics: 'legacy-cost-base-v1', cost_base_weight_g: 100,
          attribute_4383_weight_g: 100, attribute_4497_weight_g: 150, draft_weight_g: 100,
          source_weight_g: 100, packaged_weight_g: 100, platform_attribute_weight_g: 150,
          packaging_increment_g: 50,
        },
      }],
    });
  });

  it('enforces volumetric boundaries without widening CEL support', () => {
    const atLimit = calculateCelCandidates({ actual_weight_kg: 3, volume_weight_kg: 31, length_cm: 100, width_cm: 100, height_cm: 100 }, 'land');
    const overLimit = calculateCelCandidates({ actual_weight_kg: 3, volume_weight_kg: 31.001, length_cm: 100, width_cm: 100, height_cm: 100 }, 'land');
    expect(atLimit.some((item) => item.name === 'Big')).toBe(true);
    expect(overLimit.some((item) => item.name === 'Big')).toBe(false);

    const premiumAtLimit = calculateCelCandidates({ actual_weight_kg: 6, volume_weight_kg: 80, length_cm: 150, width_cm: 80, height_cm: 80 }, 'land');
    const premiumOverLimit = calculateCelCandidates({ actual_weight_kg: 6, volume_weight_kg: 80.001, length_cm: 150, width_cm: 80, height_cm: 80 }, 'land');
    expect(premiumAtLimit.some((item) => item.name === 'Premium Big')).toBe(true);
    expect(premiumOverLimit.some((item) => item.name === 'Premium Big')).toBe(false);
  });

  it('solves target-margin pricing against the matching commission tier', async () => {
    const result = await runCostPricing({
      product: product(), category_decision: decision(), fx_rate: fx(), commission_snapshot: commission(),
      profile: { pricing_mode: 'target_margin', retained_target_percent: 20 },
    });
    expect(result).toMatchObject({
      ok: true,
      data: {
        profile: { pricing_mode: 'target_margin' },
        sku_pricing: [{ final_price_cny: 31, commission: { rate_percent: 12 } }],
      },
    });
    expect(result.data!.sku_pricing[0]!.estimated_profit_margin_percent).toBeGreaterThanOrEqual(20);
  });

  it('requests Agent packaging without fetching FX when source packaging is invalid', async () => {
    const input = product();
    input.skus[0]!.package.weight_unit = 'unknown';
    const provider = { getCnyRub: vi.fn(async () => fx()) };
    const result = await runCostPricing({
      product: input, category_decision: decision(), fx_provider: provider, commission_snapshot: commission(),
    });
    expect(result.data).toMatchObject({ status: 'needs_agent', fx_rate: null });
    expect(result.data?.agent_tasks).toHaveLength(1);
    expect(provider.getCnyRub).not.toHaveBeenCalled();
  });

  it('applies a 20 percent weight buffer to Agent estimates and continues', async () => {
    const input = product();
    input.skus[0]!.package.weight_unit = 'unknown';
    const result = await runCostPricing({
      product: input,
      category_decision: decision(),
      fx_rate: fx(),
      commission_snapshot: commission(),
      agent_input: {
        source_offer_id: 'offer-1',
        sku_inputs: [{
          source_sku_id: 'sku-1', packaged_weight_g: 101,
          length_cm: 10, width_cm: 10, height_cm: 10,
          rationale: 'Estimated from one small product.', evidence: ['source title'],
        }],
      },
    });
    expect(result.data?.sku_pricing[0]?.package).toMatchObject({
      source: 'agent_estimated', source_weight_g: 101, actual_weight_g: 122,
      estimate_weight_buffer_percent: 20,
    });
  });

  it('preserves an over-limit 1688 package and never replaces it with an Agent estimate', async () => {
    const input = product();
    Object.assign(input.skus[0]!.package, { raw_weight: 31, weight_unit: 'kg', length_cm: 160, width_cm: 90, height_cm: 90 });
    const result = await runCostPricing({
      product: input, category_decision: decision(), fx_rate: fx(), commission_snapshot: commission(),
      agent_input: {
        source_offer_id: 'offer-1',
        sku_inputs: [{ source_sku_id: 'sku-1', packaged_weight_g: 100, length_cm: 10, width_cm: 10, height_cm: 10, rationale: 'must not win', evidence: [] }],
      },
    });
    expect(result.data?.resolved_packages[0]).toMatchObject({
      source_sku_id: 'sku-1',
      package: { source: '1688', confidence: 'high', actual_weight_g: 31_000, length_cm: 160, width_cm: 90, height_cm: 90 },
    });
    expect(result.data?.agent_tasks).toEqual([]);
    expect(result.errors.map((error) => error.code)).toEqual(expect.arrayContaining([
      'LOGISTICS_PROVIDER_UNSUPPORTED_PACKAGE', 'CEL_NO_APPLICABLE_TARIFF',
    ]));
  });

  it('uses explicit user packaging only when source facts are incomplete', async () => {
    const input = product();
    input.skus[0]!.package.matched_by = 'none';
    input.skus[0]!.package.raw_weight = null;
    const result = await runCostPricing({
      product: input, category_decision: decision(), fx_rate: fx(), commission_snapshot: commission(),
      package_inputs: [{ source_sku_id: 'sku-1', packaged_weight_g: 200, length_cm: 12, width_cm: 11, height_cm: 10, rationale: 'Customer measured one sales unit.' }],
    });
    expect(result.data?.resolved_packages[0]?.package).toMatchObject({ source: 'user_provided', confidence: 'high', actual_weight_g: 200 });
    expect(result.data?.status).toBe('completed');
  });

  it('rejects internally inconsistent exchange-rate fields', async () => {
    const badFx = { ...fx(), rub_per_cny: 9 };
    const result = await runCostPricing({
      product: product(), category_decision: decision(), fx_rate: badFx, commission_snapshot: commission(),
    });
    expect(result).toMatchObject({
      ok: false,
      errors: [{ code: 'COST_PRICING_FAILED', message: 'CNY/RUB exchange-rate fields are inconsistent.' }],
    });
  });
});

function candidates(weightG: number, length = 10, width = 10, height = 10) {
  return calculateCelCandidates({
    actual_weight_kg: weightG / 1000,
    volume_weight_kg: length * width * height / 12000,
    length_cm: length, width_cm: width, height_cm: height,
  }, 'land');
}

function product(): CanonicalProductV2 {
  return {
    schema_version: 2,
    source: {
      platform: '1688', offer_id: 'offer-1', offer_url: 'https://detail.1688.com/offer/offer-1.html',
      collected_at: '2026-07-15T00:00:00.000Z', collection_method: 'offers', detail_url: null,
      source_category_path_zh: ['测试'], discovery_context: { search_term: null, seed_offer_id: null },
    },
    product: { title_zh: '测试商品', main_image: null, gallery_images: [], attributes: {}, price_tiers: [], sku_options: [] },
    skus: [{
      source_sku_id: 'sku-1', raw_spec_text: '默认', specs: {}, unparsed_spec_segments: [],
      price_cny: 10, multi_price_cny: null, image: null,
      package: {
        length_cm: 10, width_cm: 10, height_cm: 10, raw_weight: 100, weight_unit: 'g',
        source: '1688', matched_by: 'sku_id',
      },
    }],
    sku_analysis: {
      has_source_skus: true, is_multi_sku: false, sku_count: 1, common_fields: {}, varying_fields: [],
      variant_dimensions: [], missing_fields: [], duplicate_spec_combinations: [], warnings: [],
    },
    validation: { status: 'valid', warnings: [], errors: [] },
  };
}

function decision(): CategoryDecisionV1 {
  return {
    schema_version: 1, source_offer_id: 'offer-1',
    product_understanding: { summary_zh: '测试', product_family_zh: '测试', evidence: [] },
    representative_sku_ids: ['sku-1'], product_structure: 'single_sku', unassigned_sku_ids: [],
    category_groups: [{
      group_id: 'group', source_sku_ids: ['sku-1'], group_summary_zh: '测试', evidence: [],
      selected_category: {
        description_category_id: 92417201, description_category_name: '一次性餐具',
        type_id: 92485, type_name: '一次性杯子', category_path_zh: ['住宅和花园', '一次性餐具'],
      },
      alternative_categories: [], confidence: 'high', rationale_zh: '测试',
    }],
    status: 'decided', warnings: [], errors: [],
  };
}

function fx(): CostPricingFxRateV1 {
  return {
    provider: 'cbr', cny_nominal: 1, rub_value: 10, rub_per_cny: 10,
    published_at: '2026-07-15T00:00:00.000Z', fetched_at: '2026-07-15T00:00:00.000Z',
    source_url: 'https://www.cbr.ru/scripts/XML_daily.asp', response_sha256: 'a'.repeat(64), cache_status: 'live',
  };
}

function commission(): CostPricingCommissionSnapshotV1 {
  return {
    schema_version: 1, source: 'test', categories: [{
      category_id: 92417201, category_name: '一次性餐具',
      tiers: [
        { price_min_rub: 0, price_max_rub: 1500, rate_percent: 12 },
        { price_min_rub: 1500, price_max_rub: 5000, rate_percent: 18 },
        { price_min_rub: 5000, price_max_rub: null, rate_percent: 18 },
      ],
    }],
  };
}
