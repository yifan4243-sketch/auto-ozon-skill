import { createHash } from 'node:crypto';
import type {
  CanonicalProductV2,
  CategoryDecisionV1,
  CommandResult,
  CostPricingAgentInputV1,
  CostPricingFxRateV1,
  CostPricingPackageV1,
  CostPricingProfileV1,
  CostPricingSkuV1,
  CostPricingV1,
  CostPricingCommissionTierV1,
} from '@auto-ozon/contracts';
import { LEGACY_WEIGHT_SEMANTICS_V1 } from '@auto-ozon/contracts';
import type { WorkflowContext } from '@auto-ozon/artifact-store';
import { assertWorkflowActive } from '@auto-ozon/artifact-store';
import { loadBundledCommissionSnapshot, resolveCommissionSnapshot, selectCommissionTier } from './commission.js';
import { CbrFxRateProvider } from './fx.js';
import { calculateCelCandidates, CEL_TARIFF_VERSION, priceFitsCelBand } from './tariffs.js';
import { validateCostPricingSchema } from './schema-validator.js';

const FX_CACHE_NAMESPACE = 'cost-pricing-fx';
const FX_CACHE_KEY = 'cbr-cny-rub-latest';
const MAX_CACHE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface CostPricingFxRateProvider {
  getCnyRub(signal?: AbortSignal): Promise<CostPricingFxRateV1>;
}

export interface RunCostPricingInput {
  product: CanonicalProductV2;
  category_decision: CategoryDecisionV1;
  profile?: Partial<CostPricingProfileV1>;
  agent_input?: CostPricingAgentInputV1;
  commission_snapshot?: unknown;
  commission_snapshot_sha256?: string;
  fx_rate?: CostPricingFxRateV1;
  fx_provider?: CostPricingFxRateProvider;
}

export const DEFAULT_COST_PRICING_PROFILE: CostPricingProfileV1 = {
  transport: 'land',
  sales_unit_quantity: 1,
  pricing_mode: 'multiplier',
  pricing_multiplier: 2,
  retained_target_percent: 20,
  label_fee_cny: 2,
  domestic_shipping_cny: 0,
  other_fixed_cny: 0,
  other_rate_percent: 10,
};

export async function runCostPricing(
  input: RunCostPricingInput,
  context?: WorkflowContext,
): Promise<CommandResult<CostPricingV1>> {
  try {
    if (context) {
      assertWorkflowActive(context);
      await context.artifact_store.updateStep(context.run_id, 'cost-pricing', { status: 'running' });
    }
    const profile = validateProfile({ ...DEFAULT_COST_PRICING_PROFILE, ...input.profile });
    const bundledCommission = input.commission_snapshot ? null : await loadBundledCommissionSnapshot();
    const commissionSnapshot = input.commission_snapshot
      ? resolveCommissionSnapshot(input.commission_snapshot)
      : bundledCommission!.snapshot;
    const commissionHash = input.commission_snapshot_sha256
      ?? bundledCommission?.sha256
      ?? hashJson(input.commission_snapshot);
    if (!/^[a-f0-9]{64}$/u.test(commissionHash)) {
      throw new Error('Commission snapshot SHA-256 is invalid.');
    }
    const result = emptyResult(input.product.source.offer_id, profile, commissionHash);
    validateUpstream(input, result);
    const packages = new Map<string, CostPricingPackageV1>();
    if (result.errors.length === 0) resolvePackages(input, result, packages);

    if (result.agent_tasks.length > 0 && result.errors.length === 0) {
      result.status = 'needs_agent';
      return finish(result, context);
    }
    if (result.errors.length === 0) {
      result.fx_rate = await resolveFxRate(input, context, result);
      calculateSkuPricing(input, result, commissionSnapshot, packages);
    }
    result.status = result.errors.length > 0 ? 'blocked' : 'completed';
    return finish(result, context);
  } catch (error) {
    if (context) {
      await context.artifact_store.updateStep(context.run_id, 'cost-pricing', {
        status: 'failed', error_code: 'COST_PRICING_FAILED',
      });
    }
    return {
      ok: false,
      command: 'cost.pricing',
      warnings: [],
      errors: [{
        code: 'COST_PRICING_FAILED',
        message: error instanceof Error ? error.message : String(error),
        recoverable: true,
      }],
      nextActions: [],
    };
  }
}

function validateUpstream(input: RunCostPricingInput, result: CostPricingV1): void {
  if (input.product.validation.status === 'blocked' || input.category_decision.status !== 'decided') {
    result.errors.push(issue('BLOCKED_UPSTREAM', 'A decided category and non-blocked product are required.'));
  }
  if (input.product.source.offer_id !== input.category_decision.source_offer_id) {
    result.errors.push(issue('OFFER_ID_MISMATCH', 'Product and category decision offer IDs differ.'));
  }
  if (input.agent_input && input.agent_input.source_offer_id !== input.product.source.offer_id) {
    result.errors.push(issue('AGENT_OFFER_ID_MISMATCH', 'Pricing Agent input belongs to another offer.'));
  }
}

function resolvePackages(
  input: RunCostPricingInput,
  result: CostPricingV1,
  packages: Map<string, CostPricingPackageV1>,
): void {
  for (const group of input.category_decision.category_groups) {
    if (!group.selected_category) continue;
    for (const skuId of group.source_sku_ids) {
      const sku = input.product.skus.find((candidate) => candidate.source_sku_id === skuId);
      if (!sku) {
        result.errors.push(issue('UNKNOWN_SKU', `Unknown source SKU ${skuId}.`, [skuId]));
        continue;
      }
      if (!Number.isFinite(sku.price_cny) || sku.price_cny! <= 0) {
        result.errors.push(issue('PURCHASE_PRICE_REQUIRED', `SKU ${skuId} has no valid CNY purchase price.`, [skuId]));
        continue;
      }
      const sourcePackage = packageFrom1688(sku.package);
      const agentPackage = sourcePackage ? null : packageFromAgent(input.agent_input, skuId);
      const packaged = sourcePackage ?? agentPackage;
      if (!packaged) {
        result.agent_tasks.push({
          execution_owner: 'current_agent',
          source_sku_id: skuId,
          group_id: group.group_id,
          instruction: 'Estimate one sellable unit packaged weight in grams and package length/width/height in centimetres. Use no external model API. Do not reuse net weight as packaged weight without packaging allowance.',
          source_facts: buildSourceFacts(input.product, skuId),
        });
        continue;
      }
      if (packaged.source === 'agent_estimated') {
        result.warnings.push(issue(
          'AGENT_ESTIMATED_PACKAGE',
          `SKU ${skuId} uses low-confidence Agent-estimated packaging; weight includes a 20% buffer.`,
          [skuId],
        ));
      }
      packages.set(skuId, packaged);
    }
  }
}

async function resolveFxRate(
  input: RunCostPricingInput,
  context: WorkflowContext | undefined,
  result: CostPricingV1,
): Promise<CostPricingFxRateV1 | null> {
  if (input.fx_rate) return validateFxRate(input.fx_rate);
  const provider = input.fx_provider ?? new CbrFxRateProvider();
  try {
    const rate = validateFxRate(await provider.getCnyRub(context?.signal));
    if (context) await context.artifact_store.writeCache(FX_CACHE_NAMESPACE, FX_CACHE_KEY, rate);
    return rate;
  } catch (error) {
    const cached = context
      ? await context.artifact_store.readCache<CostPricingFxRateV1>(FX_CACHE_NAMESPACE, FX_CACHE_KEY)
      : null;
    if (cached && Date.now() - Date.parse(cached.fetched_at) <= MAX_CACHE_AGE_MS) {
      result.warnings.push(issue('FX_CACHE_FALLBACK', 'Live CBR request failed; using a cached rate not older than seven days.'));
      return { ...validateFxRate(cached), cache_status: 'cached' };
    }
    result.errors.push(issue('FX_UNAVAILABLE', error instanceof Error ? error.message : String(error)));
    return null;
  }
}

function calculateSkuPricing(
  input: RunCostPricingInput,
  result: CostPricingV1,
  commissionSnapshot: ReturnType<typeof resolveCommissionSnapshot>,
  packages: Map<string, CostPricingPackageV1>,
): void {
  if (!result.fx_rate) return;
  for (const group of input.category_decision.category_groups) {
    const category = group.selected_category;
    if (!category) continue;
    for (const skuId of group.source_sku_ids) {
      const sku = input.product.skus.find((candidate) => candidate.source_sku_id === skuId);
      const packaged = packages.get(skuId);
      if (!sku || !packaged || !sku.price_cny) continue;
      const volumeWeightKg = packaged.length_cm * packaged.width_cm * packaged.height_cm / 12000;
      const candidates = calculateCelCandidates({
        actual_weight_kg: packaged.actual_weight_g / 1000,
        volume_weight_kg: volumeWeightKg,
        length_cm: packaged.length_cm,
        width_cm: packaged.width_cm,
        height_cm: packaged.height_cm,
      }, result.profile.transport);
      const solutions: CostPricingSkuV1[] = [];
      for (const candidate of candidates) {
        const purchaseCost = sku.price_cny * result.profile.sales_unit_quantity;
        const landedCost = purchaseCost + result.profile.domestic_shipping_cny
          + result.profile.label_fee_cny + candidate.shipping_cny + result.profile.other_fixed_cny;
        const priceOptions = resolvePriceOptions(
          landedCost,
          candidate,
          category.description_category_id,
          commissionSnapshot,
          result,
        );
        for (const { finalPriceCny, finalPriceRub, commission } of priceOptions) {
        const commissionAmount = finalPriceCny * commission.rate_percent / 100;
        const otherRateAmount = finalPriceCny * result.profile.other_rate_percent / 100;
        const profit = finalPriceCny - landedCost - commissionAmount - otherRateAmount;
        solutions.push({
          source_sku_id: skuId,
          group_id: group.group_id,
          description_category_id: category.description_category_id,
          purchase_price_cny: round(sku.price_cny),
          purchase_cost_cny: round(purchaseCost),
          package: packaged,
          weight_facts: {
            semantics: LEGACY_WEIGHT_SEMANTICS_V1,
            source: packaged.source,
            confidence: packaged.confidence,
            cost_base_weight_g: packaged.actual_weight_g,
            attribute_4383_weight_g: packaged.actual_weight_g,
            attribute_4497_weight_g: packaged.actual_weight_g + 50,
            draft_weight_g: packaged.actual_weight_g,
            packaging_increment_g: 50,
          },
          volume_weight_kg: round(volumeWeightKg, 4),
          charge_weight_g: candidate.charge_weight_g,
          cel_group: candidate.name,
          cel_rate_per_g_cny: candidate.rate_per_g_cny,
          cel_fixed_fee_cny: candidate.fixed_fee_cny,
          cel_shipping_cny: candidate.shipping_cny,
          landed_cost_cny: round(landedCost),
          final_price_cny: finalPriceCny,
          final_price_rub: round(finalPriceRub),
          commission,
          commission_amount_cny: round(commissionAmount),
          other_rate_amount_cny: round(otherRateAmount),
          estimated_profit_cny: round(profit),
          estimated_profit_margin_percent: round(profit / finalPriceCny * 100),
        });
        }
      }
      if (solutions.length === 0) {
        const categoryExists = commissionSnapshot.categories.some(
          (item) => item.category_id === category.description_category_id,
        );
        result.errors.push(issue(
          categoryExists ? 'NO_CONSISTENT_PRICE_BAND' : 'COMMISSION_CATEGORY_NOT_FOUND',
          categoryExists
            ? `SKU ${skuId} has no self-consistent CEL price band.`
            : `No commission tiers found for category ${category.description_category_id}.`,
          [skuId],
        ));
      } else {
        result.sku_pricing.push(solutions.sort((left, right) => left.final_price_cny - right.final_price_cny)[0]!);
      }
    }
  }
}

function packageFrom1688(pkg: CanonicalProductV2['skus'][number]['package']): CostPricingPackageV1 | null {
  const dimensions = [pkg.length_cm, pkg.width_cm, pkg.height_cm];
  if (pkg.matched_by === 'none' || !dimensions.every(validPositive)) return null;
  if (pkg.weight_unit === 'unknown' || !validPositive(pkg.raw_weight)) return null;
  const weightG = pkg.weight_unit === 'kg' ? pkg.raw_weight! * 1000 : pkg.raw_weight!;
  const normalizedDimensions = dimensions.map(Number);
  if (
    weightG > 30000
    || Math.max(...normalizedDimensions) > 150
    || normalizedDimensions.reduce((sum, value) => sum + value, 0) > 310
  ) return null;
  return {
    source: '1688', confidence: 'high', actual_weight_g: weightG, source_weight_g: weightG,
    estimate_weight_buffer_percent: 0,
    length_cm: pkg.length_cm!, width_cm: pkg.width_cm!, height_cm: pkg.height_cm!,
    evidence: [`CanonicalProductV2 package matched_by=${pkg.matched_by}`, `weight_unit=${pkg.weight_unit}`],
  };
}

function packageFromAgent(input: CostPricingAgentInputV1 | undefined, skuId: string): CostPricingPackageV1 | null {
  const estimate = input?.sku_inputs.find((candidate) => candidate.source_sku_id === skuId);
  if (!estimate) return null;
  const values = [estimate.packaged_weight_g, estimate.length_cm, estimate.width_cm, estimate.height_cm];
  if (!values.every(validPositive)) throw new Error(`Agent package estimate for SKU ${skuId} must contain positive numbers.`);
  return {
    source: 'agent_estimated', confidence: 'low',
    source_weight_g: estimate.packaged_weight_g,
    actual_weight_g: Math.ceil(estimate.packaged_weight_g * 1.2),
    estimate_weight_buffer_percent: 20,
    length_cm: estimate.length_cm, width_cm: estimate.width_cm, height_cm: estimate.height_cm,
    evidence: [estimate.rationale, ...estimate.evidence],
  };
}

function buildSourceFacts(product: CanonicalProductV2, skuId: string): string[] {
  const sku = product.skus.find((candidate) => candidate.source_sku_id === skuId);
  if (!sku) return [];
  return [
    `title_zh=${product.product.title_zh}`,
    `source_category=${product.source.source_category_path_zh.join(' > ')}`,
    `sku_spec=${sku.raw_spec_text}`,
    `source_package=${JSON.stringify(sku.package)}`,
    ...Object.entries(product.product.attributes).map(([key, value]) => `${key}=${value}`),
  ];
}

function validateProfile(profile: CostPricingProfileV1): CostPricingProfileV1 {
  if (!['air', 'air_land', 'land'].includes(profile.transport)) throw new Error('Unsupported CEL transport.');
  if (!['multiplier', 'target_margin'].includes(profile.pricing_mode)) throw new Error('Unsupported pricing_mode.');
  if (!Number.isSafeInteger(profile.sales_unit_quantity) || profile.sales_unit_quantity <= 0) {
    throw new Error('sales_unit_quantity must be a positive integer.');
  }
  if (!validPositive(profile.pricing_multiplier)) throw new Error('pricing_multiplier must be greater than zero.');
  for (const field of ['retained_target_percent', 'label_fee_cny', 'domestic_shipping_cny', 'other_fixed_cny', 'other_rate_percent'] as const) {
    if (!Number.isFinite(profile[field]) || profile[field] < 0) throw new Error(`${field} cannot be negative.`);
  }
  if (profile.other_rate_percent >= 100) throw new Error('other_rate_percent must be below 100.');
  return profile;
}

function resolvePriceOptions(
  landedCost: number,
  candidate: ReturnType<typeof calculateCelCandidates>[number],
  categoryId: number,
  snapshot: ReturnType<typeof resolveCommissionSnapshot>,
  result: CostPricingV1,
): Array<{ finalPriceCny: number; finalPriceRub: number; commission: CostPricingCommissionTierV1 }> {
  const prices: number[] = [];
  if (result.profile.pricing_mode === 'multiplier') {
    prices.push(Math.round(landedCost * result.profile.pricing_multiplier));
  } else {
    const category = snapshot.categories.find((entry) => entry.category_id === categoryId);
    for (const tier of category?.tiers ?? []) {
      const denominator = 1 - (
        tier.rate_percent
        + result.profile.other_rate_percent
        + result.profile.retained_target_percent
      ) / 100;
      if (denominator > 0) prices.push(Math.round(landedCost / denominator));
    }
  }
  const seen = new Set<number>();
  const options: Array<{ finalPriceCny: number; finalPriceRub: number; commission: CostPricingCommissionTierV1 }> = [];
  for (const finalPriceCny of prices) {
    if (finalPriceCny <= 0 || seen.has(finalPriceCny)) continue;
    seen.add(finalPriceCny);
    const finalPriceRub = finalPriceCny * result.fx_rate!.rub_per_cny;
    if (!priceFitsCelBand(finalPriceRub, candidate)) continue;
    const commission = selectCommissionTier(snapshot, categoryId, finalPriceRub);
    if (!commission) continue;
    if (result.profile.pricing_mode === 'target_margin') {
      const achieved = (finalPriceCny - landedCost
        - finalPriceCny * commission.rate_percent / 100
        - finalPriceCny * result.profile.other_rate_percent / 100) / finalPriceCny * 100;
      if (achieved + 0.01 < result.profile.retained_target_percent) continue;
    }
    options.push({ finalPriceCny, finalPriceRub, commission });
  }
  return options;
}

function validateFxRate(rate: CostPricingFxRateV1): CostPricingFxRateV1 {
  if (!validPositive(rate.cny_nominal) || !validPositive(rate.rub_value) || !validPositive(rate.rub_per_cny)) {
    throw new Error('CNY/RUB exchange rate must be positive.');
  }
  const expected = rate.rub_value / rate.cny_nominal;
  if (Math.abs(rate.rub_per_cny - expected) > Math.max(1e-9, expected * 1e-9)) {
    throw new Error('CNY/RUB exchange-rate fields are inconsistent.');
  }
  if (!Number.isFinite(Date.parse(rate.published_at)) || !Number.isFinite(Date.parse(rate.fetched_at))) {
    throw new Error('CNY/RUB exchange-rate timestamps are invalid.');
  }
  if (!/^[a-f0-9]{64}$/u.test(rate.response_sha256)) {
    throw new Error('CNY/RUB response SHA-256 is invalid.');
  }
  return rate;
}

function emptyResult(sourceOfferId: string, profile: CostPricingProfileV1, hash: string): CostPricingV1 {
  return {
    schema_version: 1, source_offer_id: sourceOfferId, status: 'completed', profile,
    tariff_version: CEL_TARIFF_VERSION, commission_snapshot_sha256: hash, fx_rate: null,
    sku_pricing: [], agent_tasks: [], warnings: [], errors: [],
  };
}

async function finish(result: CostPricingV1, context?: WorkflowContext): Promise<CommandResult<CostPricingV1>> {
  const schema = validateCostPricingSchema(result);
  if (!schema.valid) {
    result.errors.push(issue(
      'COST_PRICING_SCHEMA_INVALID',
      `CostPricingV1 schema validation failed: ${schema.errors.map((error) => `${error.instancePath} ${error.message}`).join('; ')}`,
    ));
    result.status = 'blocked';
  }
  if (context) {
    const output = await context.artifact_store.write(context.run_id, 'cost-pricing', 'cost-pricing-v1.json', result);
    await context.artifact_store.updateStep(context.run_id, 'cost-pricing', {
      status: result.status === 'completed' ? 'succeeded' : result.status === 'needs_agent' ? 'needs_review' : 'blocked',
      output,
      error_code: result.errors[0]?.code ?? null,
    });
  }
  return {
    ok: result.status !== 'blocked', command: 'cost.pricing', data: result,
    warnings: result.warnings.map((warning) => ({ code: warning.code, message: warning.message, detail: warning })),
    errors: result.errors.map((error) => ({ code: error.code, message: error.message, detail: error, recoverable: true })),
    nextActions: result.agent_tasks.length > 0
      ? ['Have the current Agent complete agent_tasks, then rerun cost-pricing with that Agent JSON.']
      : [],
  };
}

function issue(code: string, message: string, skuIds: string[] = []) {
  return { code, message, sku_ids: skuIds };
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function validPositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
