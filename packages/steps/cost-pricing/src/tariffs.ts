import type { CostPricingTransportV1 } from '@auto-ozon/contracts';

export const CEL_TARIFF_VERSION = 'CEL-2026-effective' as const;

type Rate = { per_g: number; fixed: number };

interface TariffRule {
  name: string;
  price_min_rub: number;
  price_max_rub: number;
  rates: Partial<Record<CostPricingTransportV1, Rate>>;
  accepts(input: PackageMetrics): boolean;
  chargeWeightKg(input: PackageMetrics): number;
}

export interface PackageMetrics {
  actual_weight_kg: number;
  volume_weight_kg: number;
  length_cm: number;
  width_cm: number;
  height_cm: number;
}

export interface CelCandidate {
  name: string;
  price_min_rub: number;
  price_max_rub: number;
  charge_weight_g: number;
  rate_per_g_cny: number;
  fixed_fee_cny: number;
  shipping_cny: number;
}

const RULES: TariffRule[] = [
  rule('Extra Small', 1, 1500, {
    air: [0.0468, 3.12], air_land: [0.0364, 3.12], land: [0.026, 3.12],
  }, (m) => withinWeight(m, 0.001, 0.5) && sideSum(m) <= 90 && longest(m) <= 60),
  rule('Budget', 1, 1500, {
    air: [0.03432, 23.92], air_land: [0.026, 23.92], land: [0.01768, 23.92],
  }, (m) => m.actual_weight_kg > 0.5 && m.actual_weight_kg <= 30 && sideSum(m) <= 150 && longest(m) <= 60),
  rule('Small', 1500, 7000, {
    air: [0.0468, 16.64], air_land: [0.0364, 16.64], land: [0.026, 16.64],
  }, (m) => withinWeight(m, 0.001, 2) && sideSum(m) <= 150 && longest(m) <= 60),
  rule('Big', 1500, 7000, {
    air_land: [0.026, 37.44], land: [0.01768, 37.44],
  }, (m) => m.actual_weight_kg > 2 && m.actual_weight_kg <= 30 && sideSum(m) <= 310 && longest(m) <= 150 && m.volume_weight_kg <= 31,
  (m) => Math.max(m.actual_weight_kg, m.volume_weight_kg)),
  rule('Premium Small', 7000, 250000, {
    air: [0.0468, 22.88], air_land: [0.0364, 22.88], land: [0.026, 22.88],
  }, (m) => withinWeight(m, 0.001, 5) && sideSum(m) <= 250 && longest(m) <= 150),
  rule('Premium Big', 7000, 250000, {
    air_land: [0.02912, 64.48], land: [0.02392, 64.48],
  }, (m) => {
    const sides = sortedSides(m);
    return m.actual_weight_kg > 5 && m.actual_weight_kg <= 30 && sideSum(m) <= 310
      && sides[0]! <= 150 && sides[1]! <= 80 && sides[2]! <= 80
      && m.volume_weight_kg <= 80;
  }, (m) => Math.max(m.actual_weight_kg, m.volume_weight_kg)),
];

export function calculateCelCandidates(
  metrics: PackageMetrics,
  transport: CostPricingTransportV1,
): CelCandidate[] {
  assertMetrics(metrics);
  return RULES.flatMap((tariff) => {
    const rate = tariff.rates[transport];
    if (!rate || !tariff.accepts(metrics)) return [];
    const chargeWeightG = tariff.chargeWeightKg(metrics) * 1000;
    return [{
      name: tariff.name,
      price_min_rub: tariff.price_min_rub,
      price_max_rub: tariff.price_max_rub,
      charge_weight_g: round(chargeWeightG, 3),
      rate_per_g_cny: rate.per_g,
      fixed_fee_cny: rate.fixed,
      shipping_cny: round(chargeWeightG * rate.per_g + rate.fixed, 2),
    }];
  });
}

export function priceFitsCelBand(priceRub: number, candidate: CelCandidate): boolean {
  const lower = candidate.price_min_rub === 1
    ? priceRub >= 1
    : priceRub > candidate.price_min_rub;
  return lower && priceRub <= candidate.price_max_rub;
}

function rule(
  name: string,
  priceMinRub: number,
  priceMaxRub: number,
  rates: Record<string, [number, number]>,
  accepts: (metrics: PackageMetrics) => boolean,
  chargeWeightKg: (metrics: PackageMetrics) => number = (metrics) => metrics.actual_weight_kg,
): TariffRule {
  return {
    name,
    price_min_rub: priceMinRub,
    price_max_rub: priceMaxRub,
    rates: Object.fromEntries(Object.entries(rates).map(([key, [per_g, fixed]]) => [key, { per_g, fixed }])),
    accepts,
    chargeWeightKg,
  };
}

function withinWeight(metrics: PackageMetrics, min: number, max: number): boolean {
  return metrics.actual_weight_kg >= min && metrics.actual_weight_kg <= max;
}

function sideSum(metrics: PackageMetrics): number {
  return metrics.length_cm + metrics.width_cm + metrics.height_cm;
}

function longest(metrics: PackageMetrics): number {
  return Math.max(metrics.length_cm, metrics.width_cm, metrics.height_cm);
}

function sortedSides(metrics: PackageMetrics): number[] {
  return [metrics.length_cm, metrics.width_cm, metrics.height_cm].sort((a, b) => b - a);
}

function assertMetrics(metrics: PackageMetrics): void {
  for (const [name, value] of Object.entries(metrics)) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be greater than zero.`);
  }
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
