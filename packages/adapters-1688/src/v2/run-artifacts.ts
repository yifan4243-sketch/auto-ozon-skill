import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { CollectionMethod } from '../../../contracts/src/common.js';
import type {
  CanonicalV2RunArtifacts,
  SourcingResultV2,
} from '../../../contracts/src/sourcing-result-v2.js';
import type { OfferResult } from '../engine/commands/offers.js';
import { CliError } from '../engine/io/errors.js';
import { sanitizeOfferResult } from './offer-result-codec.js';

export interface SaveCanonicalV2RunInput {
  saveDir: string;
  command: string;
  collectionMethod: CollectionMethod;
  searchTerm: string | null;
  seedOfferId: string | null;
  result: SourcingResultV2;
  offers: OfferResult[];
  createdAt?: string;
}

export async function saveCanonicalV2Run(
  input: SaveCanonicalV2RunInput,
): Promise<CanonicalV2RunArtifacts> {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const { runId, runDirectory } = await createUniqueRunDirectory(
    input.saveDir,
    createdAt,
  );
  const rawDirectory = path.join(runDirectory, 'raw');
  const canonicalDirectory = path.join(runDirectory, 'canonical-v2');
  const integrityPath = path.join(runDirectory, 'integrity-report.json');
  const failuresPath = path.join(runDirectory, 'failures.json');
  const manifestPath = path.join(runDirectory, 'manifest.json');

  await artifactOperation(runDirectory, rawDirectory, () =>
    fs.mkdir(rawDirectory, { recursive: false }),
  );
  await artifactOperation(runDirectory, canonicalDirectory, () =>
    fs.mkdir(canonicalDirectory, { recursive: false }),
  );

  const rawNames = artifactNames(input.offers.map((offer) => offer.offerId));
  for (let index = 0; index < input.offers.length; index++) {
    const file = path.join(rawDirectory, rawNames[index]!);
    const safeOffer = sanitizeOfferResult(input.offers[index]!);
    await artifactOperation(runDirectory, file, () => writeJson(file, safeOffer));
  }

  const canonicalNames = artifactNames(
    input.result.items.map((product) => product.source.offer_id),
  );
  for (let index = 0; index < input.result.items.length; index++) {
    const file = path.join(canonicalDirectory, canonicalNames[index]!);
    await artifactOperation(runDirectory, file, () =>
      writeJson(file, input.result.items[index]),
    );
  }

  await artifactOperation(runDirectory, integrityPath, () =>
    writeJson(integrityPath, input.result.integrity_report),
  );
  await artifactOperation(runDirectory, failuresPath, () =>
    writeJson(failuresPath, input.result.failures),
  );

  const relativePaths = {
    manifest: 'manifest.json',
    raw_directory: 'raw',
    canonical_v2_directory: 'canonical-v2',
    integrity_report: 'integrity-report.json',
    failures: 'failures.json',
  };
  await artifactOperation(runDirectory, manifestPath, () =>
    writeJson(manifestPath, {
      run_id: runId,
      created_at: createdAt,
      command: input.command,
      schema_version: 2,
      collection_method: input.collectionMethod,
      search_term: input.searchTerm,
      seed_offer_id: input.seedOfferId,
      total: input.result.total,
      success: input.result.success,
      failed: input.result.failed,
      artifact_paths: relativePaths,
    }),
  );

  return {
    run_id: runId,
    run_directory: runDirectory,
    artifact_paths: {
      manifest: manifestPath,
      raw_directory: rawDirectory,
      canonical_v2_directory: canonicalDirectory,
      integrity_report: integrityPath,
      failures: failuresPath,
    },
  };
}

export async function writeCanonicalV2OutputFile(
  outputPath: string,
  value: unknown,
): Promise<string> {
  const resolved = path.resolve(outputPath);
  try {
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await writeJson(resolved, value);
    return resolved;
  } catch (error) {
    throw artifactWriteError(path.dirname(resolved), resolved, error);
  }
}

async function createUniqueRunDirectory(
  saveDir: string,
  createdAt: string,
): Promise<{ runId: string; runDirectory: string }> {
  const root = path.resolve(saveDir);
  try {
    await fs.mkdir(root, { recursive: true });
  } catch (error) {
    throw artifactWriteError(root, root, error);
  }

  const timestamp = createdAt.replace(/[:.]/g, '-');
  for (let attempt = 0; attempt < 10; attempt++) {
    const runId = `${timestamp}-${randomUUID().slice(0, 8)}`;
    const runDirectory = path.join(root, runId);
    try {
      await fs.mkdir(runDirectory, { recursive: false });
      return { runId, runDirectory };
    } catch (error) {
      if (isAlreadyExists(error)) continue;
      throw artifactWriteError(root, runDirectory, error);
    }
  }
  throw new CliError(
    1,
    'ARTIFACT_WRITE_FAILED',
    'Unable to create a unique CanonicalProductV2 run directory.',
    { artifactDir: root },
  );
}

async function artifactOperation(
  runDirectory: string,
  artifactPath: string,
  operation: () => Promise<unknown>,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    throw artifactWriteError(runDirectory, artifactPath, error);
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function artifactNames(offerIds: string[]): string[] {
  const safeIds = offerIds.map(safeOfferId);
  const counts = new Map<string, number>();
  for (const id of safeIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  return safeIds.map((id, index) =>
    counts.get(id) === 1 ? `${id}.json` : `${id}-${index + 1}.json`,
  );
}

function safeOfferId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 100) || 'unknown-offer';
}

function artifactWriteError(
  runDirectory: string,
  artifactPath: string,
  error: unknown,
): CliError {
  const message = error instanceof Error ? error.message : String(error);
  return new CliError(
    1,
    'ARTIFACT_WRITE_FAILED',
    `Failed to write CanonicalProductV2 artifact ${artifactPath}: ${message}`,
    { artifactDir: runDirectory, artifactPath },
  );
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'EEXIST';
}
