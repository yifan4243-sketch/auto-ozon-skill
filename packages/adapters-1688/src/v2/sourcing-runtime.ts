import type { CommandResult, ErrorObject } from '../../../contracts/src/command-result.js';
import type { CollectionMethod } from '../../../contracts/src/common.js';
import type { SourcingResult } from '../../../contracts/src/sourcing-result.js';
import type { SourcingResultV2 } from '../../../contracts/src/sourcing-result-v2.js';
import { checkCanonicalV2Integrity } from '../../../transformer/src/canonical-v2-integrity.js';
import { summarizeCanonicalV2Run } from '../../../transformer/src/canonical-v2-summary.js';
import type { OfferBatchResult } from '../engine/commands/offers.js';
import { CliError } from '../engine/io/errors.js';
import { offerToCanonical } from '../mappers/offer-to-canonical.js';
import {
  offerToCanonicalV2,
  type CanonicalV2DiscoveryContextInput,
} from '../mappers/offer-to-canonical-v2.js';
import {
  sanitizeOfferBatchResult,
  sanitizeOfferResult,
} from './offer-result-codec.js';
import { saveCanonicalV2Run } from './run-artifacts.js';

export interface CollectedSourcingRun {
  mode: CollectionMethod;
  query: string | null;
  imagePath: string | null;
  details: OfferBatchResult;
  filtering?: Record<string, unknown>;
}

export interface FinalizeCanonicalV2RunOptions {
  command: string;
  discoveryContext: CanonicalV2DiscoveryContextInput;
  productsDir?: string;
  collectedAt?: string;
}

export function collectedRunToV1(run: CollectedSourcingRun): SourcingResult {
  const safeDetails = sanitizeOfferBatchResult(run.details);
  return {
    mode: run.mode,
    ...(run.query !== null ? { query: run.query } : {}),
    ...(run.mode === 'image' && run.imagePath !== null
      ? { imagePath: run.imagePath }
      : {}),
    offerIds: safeDetails.offerIds,
    total: safeDetails.total,
    success: safeDetails.success,
    failed: safeDetails.failed,
    items: safeDetails.offers.map((offer) => offerToCanonical(offer, run.mode)),
    raw: {
      ...safeDetails,
      ...(run.filtering ? { filtering: structuredClone(run.filtering) } : {}),
    },
    failures: safeDetails.failures.map((failure) => ({
      offerId: failure.offerId,
      code: failure.code,
      message: failure.message,
      recoverable: failure.code !== 'BAD_INPUT',
    })),
  };
}

export function buildSourcingResultV2(
  run: CollectedSourcingRun,
  discoveryContext: CanonicalV2DiscoveryContextInput,
  collectedAt = new Date().toISOString(),
): SourcingResultV2 {
  const safeOffers = run.details.offers.map(sanitizeOfferResult);
  const items = safeOffers.map((offer) =>
    offerToCanonicalV2(offer, run.mode, collectedAt, discoveryContext),
  );
  const integrityReport = checkCanonicalV2Integrity(safeOffers, items);

  return {
    schema_version: 2,
    mode: run.mode,
    query: run.query,
    offer_ids: run.details.offerIds,
    total: run.details.total,
    success: run.details.success,
    failed: run.details.failed,
    items,
    failures: run.details.failures.map((failure) => ({
      offer_id: failure.offerId || null,
      code: failure.code,
      message: failure.message,
      recoverable: failure.code !== 'BAD_INPUT',
    })),
    summary: summarizeCanonicalV2Run(items),
    integrity_report: integrityReport,
    artifacts: null,
    raw: {
      mode: 'offers',
      total: run.details.total,
      success: run.details.success,
      failed: run.details.failed,
      offerIds: [...run.details.offerIds],
      offers: safeOffers,
      failures: run.details.failures.map((failure) => ({ ...failure })),
    },
  };
}

export async function finalizeCanonicalV2Run(
  run: CollectedSourcingRun,
  options: FinalizeCanonicalV2RunOptions,
): Promise<CommandResult<SourcingResultV2>> {
  const collectedAt = options.collectedAt ?? new Date().toISOString();
  const data = buildSourcingResultV2(
    run,
    options.discoveryContext,
    collectedAt,
  );
  const errors: ErrorObject[] = [];

  if (data.total > 0 && data.success === 0 && data.failed === data.total) {
    errors.push({
      code: 'SOURCE_COLLECTION_FAILED',
      message: 'All 1688 offer detail collections failed.',
      detail: data.failures,
      recoverable:
        data.failures.length > 0 &&
        data.failures.every((failure) => failure.recoverable),
    });
  }

  if (data.integrity_report.status === 'fail') {
    errors.push({
      code: 'V2_INTEGRITY_FAILED',
      message: 'CanonicalProductV2 conversion integrity checks failed.',
      detail: data.integrity_report,
      recoverable: false,
    });
  }

  if (options.productsDir) {
    try {
      const searchTerm = options.discoveryContext.searchTerm?.trim() || null;
      const seedOfferId = options.discoveryContext.seedOfferId?.trim() || null;
      data.artifacts = await saveCanonicalV2Run({
        productsDir: options.productsDir,
        command: options.command,
        collectionMethod: run.mode,
        searchTerm,
        seedOfferId,
        result: data,
        offers: run.details.offers,
        createdAt: collectedAt,
      });
    } catch (error) {
      errors.push(toArtifactError(error));
    }
  }

  return {
    ok: errors.length === 0,
    command: options.command,
    data,
    warnings: [],
    errors,
    nextActions: [
      ...(data.integrity_report.status === 'fail'
        ? ['Inspect integrity_report and saved artifacts before retrying.']
        : []),
      ...(errors.some(
        (error) => error.code === 'SOURCE_COLLECTION_FAILED' && error.recoverable,
      )
        ? ['Retry the failed offer collection after reviewing failures.']
        : []),
    ],
  };
}

function toArtifactError(error: unknown): ErrorObject {
  if (error instanceof CliError) {
    return {
      code: error.code,
      message: error.message,
      detail: error.details,
      recoverable: false,
    };
  }
  return {
    code: 'ARTIFACT_WRITE_FAILED',
    message: error instanceof Error ? error.message : String(error),
    recoverable: false,
  };
}
