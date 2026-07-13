import fs from 'node:fs/promises';
import path from 'node:path';
import type { CollectionMethod } from '@auto-ozon/contracts';
import {
  CliError,
  parseOfflineOfferInput,
  type CollectedSourcingRun,
  type OfferBatchResult,
} from '@auto-ozon/adapters-1688';

export interface NormalizeV2OfflineInput {
  inputPath: string;
  method?: CollectionMethod;
  searchTerm?: string | null;
  seedOfferId?: string | null;
  productsDir?: string;
}
export async function loadOfflineSourcingRun(
  input: NormalizeV2OfflineInput,
): Promise<CollectedSourcingRun> {
  if (!input.inputPath.trim()) {
    throw new CliError(2, 'BAD_INPUT', '--input is required.');
  }
  const method = input.method ?? 'offers';
  const parsed = await readOfflineInput(input.inputPath);
  const details = toBatch(parsed);
  validateBatchCounts(details);
  return {
    mode: method,
    query:
      method === 'keyword'
        ? input.searchTerm?.trim() || null
        : method === 'similar'
          ? input.seedOfferId?.trim() || null
          : null,
    imagePath: null,
    details,
  };
}

export function parseCollectionMethod(value: string | undefined): CollectionMethod {
  const method = value ?? 'offers';
  if (
    method === 'keyword' ||
    method === 'image' ||
    method === 'offers' ||
    method === 'similar'
  ) {
    return method;
  }
  throw new CliError(
    2,
    'BAD_INPUT',
    '--method must be keyword, image, offers, or similar.',
  );
}

async function readOfflineInput(inputPath: string) {
  const resolved = path.resolve(inputPath);
  let text: string;
  try {
    text = await fs.readFile(resolved, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(2, 'BAD_INPUT', `Unable to read --input file: ${message}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(2, 'BAD_INPUT', `--input must contain valid JSON: ${message}`);
  }
  return parseOfflineOfferInput(value);
}

function toBatch(input: Awaited<ReturnType<typeof readOfflineInput>>): OfferBatchResult {
  if (input.kind === 'batch') return input.batch;
  return {
    mode: 'offers',
    total: 1,
    success: 1,
    failed: 0,
    offerIds: [input.offer.offerId],
    offers: [input.offer],
    failures: [],
  };
}

function validateBatchCounts(batch: OfferBatchResult): void {
  if (
    batch.success !== batch.offers.length ||
    batch.failed !== batch.failures.length ||
    batch.total !== batch.offerIds.length
  ) {
    throw new CliError(
      2,
      'BAD_INPUT',
      'OfferBatchResult total/success/failed must match offerIds/offers/failures lengths.',
    );
  }
}
