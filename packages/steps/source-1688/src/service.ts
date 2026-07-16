import type { CommandResult } from '@auto-ozon/contracts';
import type { WorkflowContext } from '@auto-ozon/artifact-store';
import { assertWorkflowActive } from '@auto-ozon/artifact-store';
import {
  CliError,
  collectImageSource,
  collectKeywordSource,
  collectOffersSource,
  collectSimilarSource,
  sanitizeOfferBatchResult,
  type CollectedSourcingRun,
  type OffersInput,
  type SearchImageInput,
  type SearchKeywordInput,
  type SimilarInput,
} from '@auto-ozon/adapters-1688';

export type RunSource1688Input =
  | ({ mode: 'keyword' } & SearchKeywordInput)
  | ({ mode: 'image' } & SearchImageInput)
  | ({ mode: 'offers' } & OffersInput)
  | ({ mode: 'similar' } & SimilarInput);

export async function runSource1688(
  input: RunSource1688Input,
  context?: WorkflowContext,
): Promise<CommandResult<CollectedSourcingRun>> {
  const command = `source.${input.mode}`;
  try {
    if (context) {
      assertWorkflowActive(context);
      await context.artifact_store.updateStep(context.run_id, 'source-1688', {
        status: 'running',
      });
    }

    const collected = await collect(input);
    const data: CollectedSourcingRun = {
      ...collected,
      details: sanitizeOfferBatchResult(collected.details),
      ...(collected.filtering
        ? { filtering: structuredClone(collected.filtering) }
        : {}),
    };
    const allFailed =
      data.details.total > 0 &&
      data.details.success === 0 &&
      data.details.failed === data.details.total;

    if (context) {
      const output = await context.artifact_store.write(
        context.run_id,
        'source-1688',
        'offer-result.json',
        data,
      );
      await context.artifact_store.updateStep(context.run_id, 'source-1688', {
        status: allFailed ? 'failed' : 'succeeded',
        output,
        error_code: allFailed ? 'SOURCE_COLLECTION_FAILED' : null,
      });
    }

    return {
      ok: !allFailed,
      command,
      data,
      warnings: [],
      errors: allFailed
        ? [{
            code: 'SOURCE_COLLECTION_FAILED',
            message: 'All 1688 offer detail collections failed.',
            detail: data.details.failures,
            recoverable: data.details.failures.every(
              (failure) => failure.code !== 'BAD_INPUT',
            ),
          }]
        : [],
      nextActions: allFailed
        ? ['Review collection failures and retry the source step.']
        : [],
    };
  } catch (error) {
    const normalized = normalizeError(error);
    if (context) {
      await context.artifact_store.updateStep(context.run_id, 'source-1688', {
        status: normalized.code === 'RISK_CONTROL' ? 'blocked' : 'failed',
        error_code: normalized.code,
      });
    }
    return {
      ok: false,
      command,
      warnings: [],
      errors: [normalized],
      nextActions:
        normalized.code === 'RISK_CONTROL'
          ? ['Retry with --headed and complete 1688 verification manually.']
          : normalized.code === 'NOT_LOGGED_IN'
            ? ['Run auto-ozon 1688 login.']
            : [],
    };
  }
}

function collect(input: RunSource1688Input): Promise<CollectedSourcingRun> {
  switch (input.mode) {
    case 'keyword':
      return collectKeywordSource(input);
    case 'image':
      return collectImageSource(input);
    case 'offers':
      return collectOffersSource(input);
    case 'similar':
      return collectSimilarSource(input);
  }
}

function normalizeError(error: unknown): {
  code: string;
  message: string;
  detail?: unknown;
  recoverable: boolean;
} {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const risk = /x5secdata|punish|captcha|verify|nocaptcha|滑块|验证码/i.test(rawMessage);
  if (risk) {
    return {
      code: 'RISK_CONTROL',
      message:
        '1688 risk control or verification required. Run with --headed and complete verification manually.',
      recoverable: true,
    };
  }
  if (error instanceof CliError) {
    return {
      code: error.code,
      message: error.message,
      detail: error.details,
      recoverable: error.code !== 'BAD_INPUT',
    };
  }
  return {
    code: 'SOURCE_COLLECTION_FAILED',
    message: rawMessage,
    recoverable: true,
  };
}
