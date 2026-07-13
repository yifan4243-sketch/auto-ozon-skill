import type {
  CommandResult,
  SourcingResult,
  SourcingResultV2,
  WorkflowStepStatus,
} from '@auto-ozon/contracts';
import type { WorkflowContext } from '@auto-ozon/artifact-store';
import { assertWorkflowActive } from '@auto-ozon/artifact-store';
import { CliError, type CollectedSourcingRun } from '@auto-ozon/adapters-1688';
import {
  loadOfflineSourcingRun,
  type NormalizeV2OfflineInput,
} from './offline-normalize.js';
import {
  collectedRunToV1,
  finalizeCanonicalV2Run,
} from './sourcing-runtime.js';
import type { CanonicalV2DiscoveryContextInput } from './offer-to-canonical-v2.js';

export interface RunCanonicalizeProductInput {
  source?: CollectedSourcingRun;
  offline?: NormalizeV2OfflineInput;
  schema_version?: 1 | 2;
  command?: string;
  discovery_context?: CanonicalV2DiscoveryContextInput;
  products_dir?: string;
  collected_at?: string;
}

export type RunCanonicalizeProductOutput = SourcingResult | SourcingResultV2;

export async function runCanonicalizeProduct(
  input: RunCanonicalizeProductInput,
  context?: WorkflowContext,
): Promise<CommandResult<RunCanonicalizeProductOutput>> {
  const command = input.command ?? (input.offline ? 'source.normalize-v2' : 'source.canonicalize');
  try {
    if (context) {
      assertWorkflowActive(context);
      await context.artifact_store.updateStep(context.run_id, 'canonicalize-product', {
        status: 'running',
      });
    }
    if (input.source && input.offline) {
      throw new CliError(2, 'BAD_INPUT', 'Supply source or offline input, not both.');
    }
    const source = input.source ?? (input.offline
      ? await loadOfflineSourcingRun(input.offline)
      : null);
    if (!source) {
      throw new CliError(2, 'BAD_INPUT', 'A collected 1688 source result is required.');
    }

    if ((input.schema_version ?? 2) === 1) {
      const data = collectedRunToV1(source);
      if (context) {
        const output = await context.artifact_store.write(
          context.run_id,
          'canonicalize-product',
          'canonical-product-v1.json',
          data,
        );
        await context.artifact_store.updateStep(context.run_id, 'canonicalize-product', {
          status: 'succeeded',
          output,
        });
      }
      return {
        ok: true,
        command,
        data,
        warnings: [],
        errors: [],
        nextActions: [],
      };
    }

    const discovery = input.discovery_context ?? {
      searchTerm: source.mode === 'keyword' ? source.query : null,
      seedOfferId: source.mode === 'similar' ? source.query : null,
    };
    const result = await finalizeCanonicalV2Run(source, {
      command,
      discoveryContext: discovery,
      productsDir: input.products_dir ?? input.offline?.productsDir,
      collectedAt: input.collected_at,
    });

    if (context && result.data) {
      const artifactValue =
        result.data.items.length === 1 ? result.data.items[0] : result.data.items;
      const output = await context.artifact_store.write(
        context.run_id,
        'canonicalize-product',
        'canonical-product-v2.json',
        artifactValue,
      );
      const status = canonicalStatus(result.data, result.ok);
      await context.artifact_store.updateStep(context.run_id, 'canonicalize-product', {
        status,
        output,
        error_code: result.errors[0]?.code ?? null,
      });
    }
    return result;
  } catch (error) {
    const normalized = toError(error);
    if (context) {
      await context.artifact_store.updateStep(context.run_id, 'canonicalize-product', {
        status: 'failed',
        error_code: normalized.code,
      });
    }
    return {
      ok: false,
      command,
      warnings: [],
      errors: [normalized],
      nextActions: [],
    };
  }
}

function canonicalStatus(
  result: SourcingResultV2,
  ok: boolean,
): WorkflowStepStatus {
  if (!ok) return 'failed';
  if (result.items.some((item) => item.validation.status === 'blocked')) return 'blocked';
  if (result.items.some((item) => item.validation.status === 'needs_review')) {
    return 'needs_review';
  }
  return 'succeeded';
}

function toError(error: unknown): {
  code: string;
  message: string;
  detail?: unknown;
  recoverable: boolean;
} {
  if (error instanceof CliError) {
    return {
      code: error.code,
      message: error.message,
      detail: error.details,
      recoverable: error.code !== 'BAD_INPUT',
    };
  }
  return {
    code: 'CANONICALIZE_FAILED',
    message: error instanceof Error ? error.message : String(error),
    recoverable: false,
  };
}
