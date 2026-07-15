import { createHash } from 'node:crypto';
import type { CostPricingFxRateV1 } from '@auto-ozon/contracts';

const SOURCE_URL = 'https://www.cbr.ru/scripts/XML_daily.asp';

export class CbrFxRateProvider {
  async getCnyRub(signal?: AbortSignal): Promise<CostPricingFxRateV1> {
    const timeout = AbortSignal.timeout(15_000);
    const effectiveSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await fetch(SOURCE_URL, { signal: effectiveSignal, headers: { accept: 'application/xml,text/xml' } });
    if (!response.ok) throw new Error(`CBR exchange-rate request failed with HTTP ${response.status}.`);
    const xml = await response.text();
    const block = xml.match(/<Valute[^>]*>\s*<NumCode>[^<]*<\/NumCode>\s*<CharCode>CNY<\/CharCode>[\s\S]*?<\/Valute>/u)?.[0];
    if (!block) throw new Error('CBR response does not contain CNY.');
    const nominal = numberTag(block, 'Nominal');
    const rubValue = numberTag(block, 'Value');
    const date = xml.match(/Date="([^"]+)"/u)?.[1];
    if (!date || nominal <= 0 || rubValue <= 0) throw new Error('CBR CNY rate is invalid.');
    return {
      provider: 'cbr',
      cny_nominal: nominal,
      rub_value: rubValue,
      rub_per_cny: rubValue / nominal,
      published_at: parseCbrDate(date),
      fetched_at: new Date().toISOString(),
      source_url: SOURCE_URL,
      response_sha256: createHash('sha256').update(xml).digest('hex'),
      cache_status: 'live',
    };
  }
}

function numberTag(xml: string, tag: string): number {
  const text = xml.match(new RegExp(`<${tag}>([^<]+)</${tag}>`, 'u'))?.[1] ?? '';
  return Number(text.replace(',', '.'));
}

function parseCbrDate(value: string): string {
  const [day, month, year] = value.split('.').map(Number);
  if (!day || !month || !year) throw new Error(`Invalid CBR publication date: ${value}`);
  return new Date(Date.UTC(year, month - 1, day)).toISOString();
}
