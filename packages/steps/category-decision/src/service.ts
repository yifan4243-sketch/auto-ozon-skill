import type {
  CanonicalProductV2,
  CategoryDecisionV1,
  CommandResult,
} from '@auto-ozon/contracts';
import type { WorkflowContext } from '@auto-ozon/artifact-store';
import { assertWorkflowActive } from '@auto-ozon/artifact-store';
import { loadOzonCategoryIndex } from './category-tree.js';
import { validateCategoryDecisionSchema } from './schema-validator.js';
import { validateCategoryDecision } from './validator.js';
import type { CategoryDecisionProvider } from './providers/provider.js';

export interface RunCategoryDecisionInput {
  product: CanonicalProductV2;
  provider: CategoryDecisionProvider;
  treePath?: string;
}

export async function runCategoryDecision(
  input: RunCategoryDecisionInput,
  context?: WorkflowContext,
): Promise<CommandResult<CategoryDecisionV1>> {
  try {
    if (context) {
      assertWorkflowActive(context);
      await context.artifact_store.updateStep(context.run_id, 'category-decision', {
        status: 'running',
      });
    }

    const decision = await input.provider.load(input.product);
    const schema = validateCategoryDecisionSchema(decision);
    if (!schema.valid) {
      return fail(
        'CATEGORY_DECISION_SCHEMA_INVALID',
        'CategoryDecisionV1 does not match its public schema.',
        decision,
        context,
        schema.errors,
      );
    }

    const index = await loadOzonCategoryIndex(input.treePath);
    const validation = validateCategoryDecision(decision, input.product, index);
    if (!validation.valid) {
      return fail(
        'CATEGORY_DECISION_VALIDATION_FAILED',
        'Category decision failed category-pair or SKU-coverage validation.',
        decision,
        context,
        validation.violations,
      );
    }

    if (context) {
      const output = await context.artifact_store.write(
        context.run_id,
        'category-decision',
        'category-decision-v1.json',
        decision,
      );
      await context.artifact_store.updateStep(context.run_id, 'category-decision', {
        status: decision.status === 'decided' ? 'succeeded' : decision.status,
        output,
      });
    }

    return {
      ok: decision.status !== 'blocked',
      command: 'category.decision',
      data: decision,
      warnings: decision.warnings.map((warning) => ({
        code: warning.code,
        message: warning.message,
        detail: { sku_ids: warning.sku_ids },
      })),
      errors: decision.errors.map((error) => ({
        code: error.code,
        message: error.message,
        detail: { sku_ids: error.sku_ids },
        recoverable: true,
      })),
      nextActions:
        decision.status === 'needs_review'
          ? ['Review category alternatives before retrieving attributes.']
          : [],
    };
  } catch (error) {
    return fail(
      'CATEGORY_DECISION_FAILED',
      error instanceof Error ? error.message : String(error),
      undefined,
      context,
    );
  }
}

async function fail(
  code: string,
  message: string,
  data: CategoryDecisionV1 | undefined,
  context: WorkflowContext | undefined,
  detail?: unknown,
): Promise<CommandResult<CategoryDecisionV1>> {
  if (context) {
    await context.artifact_store.updateStep(context.run_id, 'category-decision', {
      status: 'failed',
      error_code: code,
    });
  }
  return {
    ok: false,
    command: 'category.decision',
    ...(data ? { data } : {}),
    warnings: [],
    errors: [{ code, message, detail, recoverable: true }],
    nextActions: [],
  };
}
