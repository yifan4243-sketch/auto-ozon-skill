import fs from 'node:fs/promises';
import path from 'node:path';
import type { CommandResult, ErrorObject } from '../../../contracts/src/command-result.js';
import type { CollectionMethod } from '../../../contracts/src/common.js';
import type { SourcingResultV2 } from '../../../contracts/src/sourcing-result-v2.js';
import type { OfferBatchResult } from '../engine/commands/offers.js';
import { CliError } from '../engine/io/errors.js';
import { parseOfflineOfferInput } from './offer-result-codec.js';
import {
  finalizeCanonicalV2Run,
  type CollectedSourcingRun,
} from './sourcing-runtime.js';
import { writeCanonicalV2OutputFile } from './run-artifacts.js';

export interface NormalizeV2OfflineInput {
  inputPath: string;
  method?: CollectionMethod;
  searchTerm?: string | null;
  seedOfferId?: string | null;
  outputPath?: string;
  saveDir?: string;
}

export async function normalizeV2Offline(
  input: NormalizeV2OfflineInput,
): Promise<CommandResult<SourcingResultV2>> {
  try {
    if (!input.inputPath.trim()) {
      throw new CliError(2, 'BAD_INPUT', '--input is required.');
    }
    const method = input.method ?? 'offers';
    const parsed = await readOfflineInput(input.inputPath);
    const details = toBatch(parsed);
    validateBatchCounts(details);
    const run: CollectedSourcingRun = {
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
    const result = await finalizeCanonicalV2Run(run, {
      command: 'source.normalize-v2',
      discoveryContext: {
        searchTerm: input.searchTerm ?? null,
        seedOfferId: input.seedOfferId ?? null,
      },
      saveDir: input.saveDir,
    });

    if (input.outputPath) {
      try {
        await writeCanonicalV2OutputFile(input.outputPath, result);
      } catch (error) {
        const outputError = toErrorObject(error);
        result.ok = false;
        result.errors.push(outputError);
      }
    }
    return result;
  } catch (error) {
    const err = toErrorObject(error);
    return {
      ok: false,
      command: 'source.normalize-v2',
      warnings: [],
      errors: [err],
      nextActions: [],
    };
  }
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

function toErrorObject(error: unknown): ErrorObject {
  if (error instanceof CliError) {
    return {
      code: error.code,
      message: error.message,
      detail: error.details,
      recoverable: false,
    };
  }
  return {
    code: 'UNEXPECTED_ERROR',
    message: error instanceof Error ? error.message : String(error),
    recoverable: false,
  };
}
