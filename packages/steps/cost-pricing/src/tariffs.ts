import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CostPricingTransportV1 } from '@auto-ozon/contracts';

export const CEL_TARIFF_VERSION = 'CEL-2026-effective' as const;

type Rate = { per_g_cny: string; fixed_cny: string };
interface CelTariffRuleV1 {
  name: string;
  price_min_rub: number;
  price_min_inclusive: boolean;
  price_max_rub: number;
  actual_weight_min_kg: number;
  actual_weight_min_inclusive: boolean;
  actual_weight_max_kg: number;
  side_sum_max_cm: number;
  longest_side_max_cm: number;
  volume_weight_max_kg: number | null;
  sorted_side_max_cm: [number, number, number] | null;
  charge_weight: 'actual' | 'max_actual_volume';
  rates: Partial<Record<CostPricingTransportV1, Rate>>;
}

export interface CelTariffSnapshotV1 {
  schema_version: 1;
  provider_id: 'cel';
  provider_name: 'CEL';
  snapshot_id: typeof CEL_TARIFF_VERSION;
  service_modes: CostPricingTransportV1[];
  currency: 'CNY';
  source: {
    kind: 'legacy_manual_snapshot';
    reference: string;
    verification_status: 'needs_review';
  };
  captured_at: string | null;
  valid_from: string | null;
  valid_to: string | null;
  sha256: string;
  rules: CelTariffRuleV1[];
}

export interface PackageMetrics {
  actual_weight_kg: number;
  volume_weight_kg: number;
  length_cm: number;
  width_cm: number;
  height_cm: number;
}

export interface LogisticsCandidate {
  name: string;
  price_min_rub: number;
  price_min_inclusive: boolean;
  price_max_rub: number;
  charge_weight_g: number;
  rate_per_g_cny: number;
  fixed_fee_cny: number;
  shipping_cny: number;
}

export type CelCandidate = LogisticsCandidate;

export interface LogisticsTariffProvider {
  readonly provider_id: string;
  readonly version: string;
  readonly snapshot_sha256: string;
  calculateCandidates(input: PackageMetrics, serviceMode: CostPricingTransportV1): LogisticsCandidate[];
}

export class CelLogisticsTariffProvider implements LogisticsTariffProvider {
  readonly provider_id = 'cel';
  readonly version: string;
  readonly snapshot_sha256: string;

  constructor(readonly snapshot: CelTariffSnapshotV1 = loadCelTariffSnapshot()) {
    this.version = snapshot.snapshot_id;
    this.snapshot_sha256 = snapshot.sha256;
  }

  calculateCandidates(metrics: PackageMetrics, serviceMode: CostPricingTransportV1): LogisticsCandidate[] {
    assertMetrics(metrics);
    return this.snapshot.rules.flatMap((rule) => {
      const rate = rule.rates[serviceMode];
      if (!rate || !accepts(rule, metrics)) return [];
      const chargeWeightKg = rule.charge_weight === 'max_actual_volume'
        ? Math.max(metrics.actual_weight_kg, metrics.volume_weight_kg)
        : metrics.actual_weight_kg;
      const chargeWeightG = chargeWeightKg * 1000;
      return [{
        name: rule.name,
        price_min_rub: rule.price_min_rub,
        price_min_inclusive: rule.price_min_inclusive,
        price_max_rub: rule.price_max_rub,
        charge_weight_g: round(chargeWeightG, 3),
        rate_per_g_cny: Number(rate.per_g_cny),
        fixed_fee_cny: Number(rate.fixed_cny),
        shipping_cny: tariffMoney(chargeWeightG, rate),
      }];
    });
  }
}

let cachedSnapshot: CelTariffSnapshotV1 | null = null;

export function loadCelTariffSnapshot(): CelTariffSnapshotV1 {
  if (cachedSnapshot) return cachedSnapshot;
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const file = path.resolve(moduleDirectory, '../references/logistics/cel-2026.json');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as CelTariffSnapshotV1;
  validateSnapshot(parsed);
  cachedSnapshot = parsed;
  return parsed;
}

export function calculateCelCandidates(metrics: PackageMetrics, transport: CostPricingTransportV1): CelCandidate[] {
  return new CelLogisticsTariffProvider().calculateCandidates(metrics, transport);
}

export function priceFitsCelBand(priceRub: number, candidate: CelCandidate): boolean {
  const lower = candidate.price_min_inclusive ? priceRub >= candidate.price_min_rub : priceRub > candidate.price_min_rub;
  return lower && priceRub <= candidate.price_max_rub;
}

function validateSnapshot(snapshot: CelTariffSnapshotV1): void {
  if (snapshot.schema_version !== 1 || snapshot.provider_id !== 'cel' || snapshot.snapshot_id !== CEL_TARIFF_VERSION
    || snapshot.currency !== 'CNY' || !Array.isArray(snapshot.rules) || snapshot.rules.length === 0
    || !/^[a-f0-9]{64}$/u.test(snapshot.sha256)) {
    throw new Error('CEL_TARIFF_SNAPSHOT_INVALID');
  }
  const actual = createHash('sha256').update(JSON.stringify(snapshot.rules)).digest('hex');
  if (actual !== snapshot.sha256) throw new Error('CEL_TARIFF_SNAPSHOT_HASH_MISMATCH');
}

function accepts(rule: CelTariffRuleV1, metrics: PackageMetrics): boolean {
  const aboveMinimum = rule.actual_weight_min_inclusive
    ? metrics.actual_weight_kg >= rule.actual_weight_min_kg
    : metrics.actual_weight_kg > rule.actual_weight_min_kg;
  if (!aboveMinimum || metrics.actual_weight_kg > rule.actual_weight_max_kg) return false;
  if (sideSum(metrics) > rule.side_sum_max_cm || longest(metrics) > rule.longest_side_max_cm) return false;
  if (rule.volume_weight_max_kg !== null && metrics.volume_weight_kg > rule.volume_weight_max_kg) return false;
  if (rule.sorted_side_max_cm) {
    const sides = sortedSides(metrics);
    if (sides.some((side, index) => side > rule.sorted_side_max_cm![index]!)) return false;
  }
  return true;
}

function tariffMoney(chargeWeightG: number, rate: Rate): number {
  const weightMilligrams = BigInt(Math.round(chargeWeightG * 1000));
  const perGramMicros = decimalMicros(rate.per_g_cny);
  const fixedMicros = decimalMicros(rate.fixed_cny);
  const variableMicros = (weightMilligrams * perGramMicros + 500n) / 1000n;
  return Number((variableMicros + fixedMicros + 5_000n) / 10_000n) / 100;
}

function decimalMicros(value: string): bigint {
  const match = value.match(/^(\d+)(?:\.(\d{1,6}))?$/u);
  if (!match) throw new Error('CEL_TARIFF_DECIMAL_INVALID');
  return BigInt(match[1]!) * 1_000_000n + BigInt((match[2] ?? '').padEnd(6, '0'));
}

function sideSum(metrics: PackageMetrics): number { return metrics.length_cm + metrics.width_cm + metrics.height_cm; }
function longest(metrics: PackageMetrics): number { return Math.max(metrics.length_cm, metrics.width_cm, metrics.height_cm); }
function sortedSides(metrics: PackageMetrics): number[] { return [metrics.length_cm, metrics.width_cm, metrics.height_cm].sort((a, b) => b - a); }
function assertMetrics(metrics: PackageMetrics): void {
  for (const [name, value] of Object.entries(metrics)) if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be greater than zero.`);
}
function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
