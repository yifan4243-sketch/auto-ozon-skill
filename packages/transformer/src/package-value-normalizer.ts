export const MIN_VALID_SOURCE_WEIGHT = 3;

/** Preserve the raw source value only when it meets the source-weight floor. */
export function normalizeRawWeight(value: number | null | undefined): number | null {
  return isFiniteNumber(value) && value >= MIN_VALID_SOURCE_WEIGHT ? value : null;
}

/** Package dimensions and volume must be positive source measurements. */
export function normalizePositivePackageValue(
  value: number | null | undefined,
): number | null {
  return isFiniteNumber(value) && value > 0 ? value : null;
}

function isFiniteNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
