import fs from 'node:fs/promises';
import type { CollectionMethod } from '../../../contracts/src/common.js';
import type {
  CanonicalV2IntegrityReport,
  CanonicalV2RunArtifacts,
  SourcingResultV2,
} from '../../../contracts/src/sourcing-result-v2.js';
import {
  ensureProductWorkspace,
  resolveProductsRoot,
  writeProductWorkspaceArtifact,
} from '../../../core/src/product-workspace.js';
import type { OfferResult } from '../engine/commands/offers.js';
import { CliError } from '../engine/io/errors.js';
import { sanitizeOfferResult } from './offer-result-codec.js';

export interface SaveCanonicalV2RunInput {
  productsDir?: string;
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
  const productsRoot = resolveProductsRoot(input.productsDir);
  const offersById = new Map(
    input.offers.map((offer) => [String(offer.offerId), offer] as const),
  );
  const products: CanonicalV2RunArtifacts['products'] = [];
  const failures: CanonicalV2RunArtifacts['failures'] = [];

  try {
    await fs.mkdir(productsRoot, { recursive: true });

    for (const product of input.result.items) {
      const offerId = product.source.offer_id;
      const offer = offersById.get(offerId);
      if (!offer) {
        throw new Error(`Missing sanitized source offer for CanonicalProductV2 ${offerId}.`);
      }
      const workspace = await ensureProductWorkspace(offerId, productsRoot);
      await fs.rm(workspace.artifacts.source_failure, { force: true });
      const collection = {
        command: input.command,
        method: input.collectionMethod,
        search_term: input.searchTerm,
        seed_offer_id: input.seedOfferId,
        collected_at: createdAt,
      };
      const sourcePath = await writeProductWorkspaceArtifact(
        offerId,
        'source_1688',
        sanitizeOfferResult(offer),
        {
          productsDir: productsRoot,
          manifest: { collection, stages: { source_1688: 'completed' }, updatedAt: createdAt },
        },
      );
      const canonicalPath = await writeProductWorkspaceArtifact(
        offerId,
        'canonical_v2',
        product,
        {
          productsDir: productsRoot,
          manifest: {
            collection,
            stages: { canonical_v2: canonicalStageStatus(product.validation.status) },
            updatedAt: createdAt,
          },
        },
      );
      const productIntegrity = integrityForProduct(
        input.result.integrity_report,
        offerId,
      );
      const integrityPath = await writeProductWorkspaceArtifact(
        offerId,
        'integrity_report',
        productIntegrity,
        { productsDir: productsRoot, manifest: { updatedAt: createdAt } },
      );

      products.push({
        offer_id: offerId,
        product_directory: workspace.productDirectory,
        artifact_paths: {
          manifest: workspace.manifest,
          source_1688: sourcePath,
          canonical_v2: canonicalPath,
          integrity_report: integrityPath,
        },
      });
    }

    for (const failure of input.result.failures) {
      const offerId = failure.offer_id;
      if (!offerId || !/^\d+$/.test(offerId) || offerId === '0') continue;
      const workspace = await ensureProductWorkspace(offerId, productsRoot);
      const failurePath = await writeProductWorkspaceArtifact(
        offerId,
        'source_failure',
        failure,
        {
          productsDir: productsRoot,
          manifest: {
            collection: {
              command: input.command,
              method: input.collectionMethod,
              search_term: input.searchTerm,
              seed_offer_id: input.seedOfferId,
              collected_at: createdAt,
            },
            stages: { source_1688: 'failed' },
            updatedAt: createdAt,
          },
        },
      );
      failures.push({
        offer_id: offerId,
        product_directory: workspace.productDirectory,
        manifest: workspace.manifest,
        source_failure: failurePath,
      });
    }

    return { products_root: productsRoot, products, failures };
  } catch (error) {
    throw artifactWriteError(productsRoot, error);
  }
}

function integrityForProduct(
  report: CanonicalV2IntegrityReport,
  offerId: string,
): CanonicalV2IntegrityReport {
  const productResults = report.product_results.filter(
    (result) => result.offer_id === offerId,
  );
  const violations = report.violations.filter(
    (violation) => violation.offer_id === offerId,
  );
  return {
    status:
      violations.length > 0 || productResults.some((result) => !result.passed)
        ? 'fail'
        : 'pass',
    checked_product_count: productResults.length,
    violations,
    product_results: productResults,
  };
}

function canonicalStageStatus(
  status: 'valid' | 'warning' | 'needs_review' | 'blocked',
): 'completed' | 'needs_review' | 'blocked' {
  if (status === 'needs_review' || status === 'blocked') return status;
  return 'completed';
}

function artifactWriteError(
  productsRoot: string,
  error: unknown,
  artifactPath = productsRoot,
): CliError {
  const message = error instanceof Error ? error.message : String(error);
  return new CliError(
    1,
    'ARTIFACT_WRITE_FAILED',
    `Failed to write product workspace artifact ${artifactPath}: ${message}`,
    { productsRoot, artifactPath },
  );
}
