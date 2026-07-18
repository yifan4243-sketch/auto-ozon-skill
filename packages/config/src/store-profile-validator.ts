import type { StoreProfileV2 } from '@auto-ozon/contracts';

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const SAFE_ENV_KEY = /^[A-Z_][A-Z0-9_]{0,127}$/u;
const ALLOWED_KEYS = new Set([
  'schema_version', 'store_id', 'store_name', 'market', 'currency_code',
  'credentials', 'performance_credentials', 'publishing', 'pricing', 'polling',
]);

export function validateStoreProfileV2(value: unknown): StoreProfileV2 {
  if (!isRecord(value)) throw new Error('Store profile must be an object.');
  const unknown = Object.keys(value).filter((key) => !ALLOWED_KEYS.has(key));
  if (unknown.length) throw new Error(`Unknown store profile fields: ${unknown.join(', ')}`);
  if (value.schema_version !== 2) throw new Error('Store profile schema_version must be 2.');
  if (typeof value.store_id !== 'string' || !SAFE_ID.test(value.store_id)) throw new Error('Invalid store_id.');
  if (typeof value.store_name !== 'string' || !value.store_name.trim()) throw new Error('store_name is required.');
  if (value.market !== 'RU') throw new Error('Only RU market is supported.');
  if (!['CNY', 'RUB'].includes(String(value.currency_code))) throw new Error('currency_code must be CNY or RUB.');
  validateCredentials(value.credentials);
  if (value.performance_credentials !== undefined) validatePerformanceCredentials(value.performance_credentials);
  validatePublishing(value.publishing);
  validatePricing(value.pricing);
  validatePolling(value.polling);
  return value as unknown as StoreProfileV2;
}

function validatePerformanceCredentials(value: unknown): void {
  if (!isRecord(value)) throw new Error('performance_credentials must be an object.');
  const unknown = Object.keys(value).filter((key) => !['client_id', 'client_secret'].includes(key));
  if (unknown.length) throw new Error(`Unknown performance credential fields: ${unknown.join(', ')}`);
  for (const field of ['client_id', 'client_secret'] as const) {
    const reference = value[field];
    if (!isRecord(reference) || reference.provider !== 'env' || typeof reference.key !== 'string' || !SAFE_ENV_KEY.test(reference.key)) {
      throw new Error(`performance_credentials.${field} must be a safe env SecretRef.`);
    }
  }
}

function validateCredentials(value: unknown): void {
  if (!isRecord(value)) throw new Error('credentials are required.');
  for (const field of ['client_id', 'api_key'] as const) {
    const reference = value[field];
    if (!isRecord(reference) || reference.provider !== 'env' || typeof reference.key !== 'string' || !SAFE_ENV_KEY.test(reference.key)) {
      throw new Error(`credentials.${field} must be a safe env SecretRef.`);
    }
  }
}

function validatePublishing(value: unknown): void {
  if (!isRecord(value) || typeof value.enabled !== 'boolean' || value.automation_level !== 'automatic') throw new Error('Invalid publishing policy.');
  if (!Array.isArray(value.allowed_description_category_ids) || value.allowed_description_category_ids.some((id) => !Number.isInteger(id) || Number(id) <= 0)) throw new Error('Invalid category allowlist.');
  for (const field of ['max_items_per_batch', 'daily_listing_limit']) if (!Number.isInteger(value[field]) || Number(value[field]) <= 0) throw new Error(`publishing.${field} must be a positive integer.`);
}

function validatePricing(value: unknown): void {
  if (!isRecord(value) || !['multiplier', 'target_margin'].includes(String(value.mode))) throw new Error('Invalid pricing mode.');
  if (value.mode === 'multiplier' && !positiveDecimal(value.multiplier)) throw new Error('Multiplier mode requires a positive multiplier.');
  if (value.mode === 'target_margin' && !percentage(value.target_margin_percent)) throw new Error('Target-margin mode requires target_margin_percent.');
  for (const field of ['minimum_margin_percent', 'advertising_reserve_percent', 'return_loss_reserve_percent', 'other_rate_percent', 'label_fee_cny', 'other_fixed_cny']) {
    if (!nonNegativeDecimal(value[field])) throw new Error(`pricing.${field} must be a non-negative decimal string.`);
  }
}

function validatePolling(value: unknown): void {
  if (!isRecord(value) || !Number.isInteger(value.timeout_ms) || Number(value.timeout_ms) <= 0 || !Number.isInteger(value.interval_ms) || Number(value.interval_ms) < 0 || value.max_recoverable_retries !== 2) throw new Error('Invalid polling policy.');
}

function positiveDecimal(value: unknown): boolean { return typeof value === 'string' && /^\d+(?:\.\d+)?$/u.test(value) && Number(value) > 0; }
function nonNegativeDecimal(value: unknown): boolean { return typeof value === 'string' && /^\d+(?:\.\d+)?$/u.test(value); }
function percentage(value: unknown): boolean { return nonNegativeDecimal(value) && Number(value) < 100; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
