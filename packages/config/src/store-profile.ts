import fs from 'node:fs/promises';
import path from 'node:path';
import type { StorePublishProfileV1 } from '@auto-ozon/contracts';

export async function loadStorePublishProfile(file: string): Promise<StorePublishProfileV1> {
  const value = JSON.parse(await fs.readFile(path.resolve(file), 'utf8')) as unknown;
  if (!isStorePublishProfile(value)) throw new Error(`Invalid StorePublishProfileV1: ${file}`);
  return value;
}

export function isStorePublishProfile(value: unknown): value is StorePublishProfileV1 {
  if (!record(value) || value.schema_version !== 1 || !record(value.publishing) || !record(value.pricing) || !record(value.polling)) return false;
  return typeof value.publishing.enabled === 'boolean' && typeof value.publishing.credentials_ref === 'string' &&
    value.pricing.currency_code === 'CNY' && typeof value.pricing.markup_multiplier === 'number' &&
    typeof value.vat === 'string' && typeof value.polling.interval_ms === 'number' &&
    typeof value.polling.timeout_ms === 'number' && value.polling.max_retries === 2;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
