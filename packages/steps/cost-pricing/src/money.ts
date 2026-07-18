const SCALE = 1_000_000n;
const HUNDRED_SCALED = 100_000_000n;

export type MoneyMicros = bigint;

export function money(value: number): MoneyMicros {
  if (!Number.isFinite(value)) throw new Error('MONEY_VALUE_INVALID');
  return BigInt(Math.round(value * Number(SCALE)));
}

export function moneyNumber(value: MoneyMicros, digits = 2): number {
  const number = Number(value) / Number(SCALE);
  const factor = 10 ** digits;
  return Math.round(number * factor) / factor;
}

export function addMoney(...values: MoneyMicros[]): MoneyMicros {
  return values.reduce((total, value) => total + value, 0n);
}

export function subtractMoney(value: MoneyMicros, ...costs: MoneyMicros[]): MoneyMicros {
  return costs.reduce((total, cost) => total - cost, value);
}

export function multiplyMoney(value: MoneyMicros, multiplier: number): MoneyMicros {
  return divideRounded(value * decimalScale(multiplier), SCALE);
}

export function percentageMoney(value: MoneyMicros, percent: number): MoneyMicros {
  return divideRounded(value * decimalScale(percent), HUNDRED_SCALED);
}

export function divideByRemainingPercent(value: MoneyMicros, deductedPercent: number): MoneyMicros {
  const denominator = HUNDRED_SCALED - decimalScale(deductedPercent);
  if (denominator <= 0n) throw new Error('PRICE_DENOMINATOR_INVALID');
  return divideCeil(value * HUNDRED_SCALED, denominator);
}

export function roundMoneyToWhole(value: MoneyMicros): number {
  return Number(divideRounded(value, SCALE));
}

export function ceilMoneyToWhole(value: MoneyMicros): number {
  return Number(divideCeil(value, SCALE));
}

function decimalScale(value: number): bigint {
  if (!Number.isFinite(value)) throw new Error('DECIMAL_VALUE_INVALID');
  return BigInt(Math.round(value * Number(SCALE)));
}

function divideRounded(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error('DIVISOR_INVALID');
  const sign = numerator < 0n ? -1n : 1n;
  const absolute = numerator < 0n ? -numerator : numerator;
  return sign * ((absolute + denominator / 2n) / denominator);
}

function divideCeil(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n || numerator < 0n) throw new Error('DIVISION_VALUE_INVALID');
  return (numerator + denominator - 1n) / denominator;
}
