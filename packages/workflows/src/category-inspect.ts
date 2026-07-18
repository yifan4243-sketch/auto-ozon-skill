import type {
  CanonicalProductV2,
  CategoryAttributesGroupV1,
  CategoryDecisionV1,
  CommandResult,
  SourcingResultV2,
} from '@auto-ozon/contracts';
import {
  FileDecisionProvider,
  runCategoryDecision,
  type CategoryDecisionProvider,
} from '@auto-ozon/step-category-decision';
import { runCategoryAttributes } from '@auto-ozon/step-category-attributes';
import { resolveProductsRoot } from '@auto-ozon/core';
import {
  saveCategoryAttributesSnapshot,
  saveCategoryDecisionSnapshot,
} from '@auto-ozon/core';
import { runSourceCommand } from './source-command.js';
import { loadOzonEnvironment, withOzonMcpCredentials } from '@auto-ozon/adapters-ozon';
import { EnvSecretProvider, FileStoreRegistry, resolveStoreCredentials } from '@auto-ozon/config';

export interface CategoryInspectOptions {
  keyword: string;
  max: number;
  skuMax?: number;
  decisionFile?: string;
  decisionProvider?: CategoryDecisionProvider;
  productsDir?: string;
  /** Explicit local StoreProfileV2 used only for the read-only Ozon request. */
  storeId?: string;
}

export interface CategoryInspectResult {
  source: SourcingResultV2;
  category_decision?: CategoryDecisionV1;
  category_attributes?: CategoryAttributesGroupV1[];
}

export async function runCategoryInspect(
  options: CategoryInspectOptions,
): Promise<CommandResult<CategoryInspectResult>> {
  if (options.max !== 1) {
    return fail(
      'CATEGORY_INSPECT_SINGLE_PRODUCT_ONLY',
      'workflow category inspect currently supports exactly one sourced product (--max 1).',
    );
  }
  const productsDir = resolveProductsRoot(options.productsDir);
  const sourced = await runSourceCommand({
    source: {
      mode: 'keyword',
      keyword: options.keyword,
      max: 1,
      skuMax: options.skuMax,
      sort: 'relevance',
    },
    schema_version: 2,
    products_dir: productsDir,
  });
  if (!sourced.ok || !sourced.data || !isSourcingResultV2(sourced.data)) {
    return {
      ok: false,
      command: 'workflow.category.inspect',
      warnings: sourced.warnings,
      errors: sourced.errors,
      nextActions: sourced.nextActions,
    };
  }
  const source = sourced.data;
  const product = source.items[0];
  if (!product) return fail('NO_PRODUCT_IN_SOURCE', 'No product found in source result items[0].', { source });

  const provider = options.decisionProvider ??
    (options.decisionFile ? new FileDecisionProvider(options.decisionFile) : null);
  if (!provider) {
    return {
      ok: true,
      command: 'workflow.category.inspect',
      data: { source },
      warnings: [{
        code: 'NO_DECISION_PROVIDER',
        message: 'No --decision-file supplied. Provide --decision-file to complete the pipeline.',
      }],
      errors: [],
      nextActions: [
        'Run the CategoryDecision Agent on the source CanonicalProductV2 output.',
        'Save the decision as JSON and re-run with --decision-file <path>.',
      ],
    };
  }

  const decided = await runCategoryDecision({ product, provider });
  if (!decided.ok || !decided.data) {
    return fromStep(source, decided);
  }
  const decision = decided.data;
  try {
    await saveCategoryDecisionSnapshot(
      { offerId: decision.source_offer_id, productsDir },
      decision,
    );
  } catch (error) {
    return workspaceFailure(source, decision, error);
  }

  if (!options.storeId) {
    return fail(
      'STORE_ID_REQUIRED',
      '--store-id is required before reading Ozon category attributes so credentials cannot fall back to an ambient store.',
      { source, category_decision: decision },
    );
  }
  const profile = new FileStoreRegistry().get(options.storeId);
  const credentials = resolveStoreCredentials(profile, new EnvSecretProvider(loadOzonEnvironment()));
  const fetched = await withOzonMcpCredentials({
    OZON_CLIENT_ID: credentials.clientId,
    OZON_API_KEY: credentials.apiKey,
  }, () => runCategoryAttributes({ category_decision: decision }));
  const attributes = fetched.data ?? [];
  try {
    await saveCategoryAttributesSnapshot(
      { offerId: decision.source_offer_id, productsDir },
      attributes,
      fetched.ok ? undefined : 'failed',
    );
  } catch (error) {
    return workspaceFailure(source, decision, error);
  }
  if (!fetched.ok) {
    return {
      ok: false,
      command: 'workflow.category.inspect',
      data: {
        source,
        category_decision: decision,
        ...(attributes.length > 0 ? { category_attributes: attributes } : {}),
      },
      warnings: fetched.warnings,
      errors: fetched.errors,
      nextActions: fetched.nextActions,
    };
  }
  return {
    ok: true,
    command: 'workflow.category.inspect',
    data: { source, category_decision: decision, category_attributes: attributes },
    warnings: [...decided.warnings, ...fetched.warnings],
    errors: [],
    nextActions: [],
  };
}

function fromStep(
  source: SourcingResultV2,
  step: CommandResult<CategoryDecisionV1>,
): CommandResult<CategoryInspectResult> {
  return {
    ok: false,
    command: 'workflow.category.inspect',
    data: { source, ...(step.data ? { category_decision: step.data } : {}) },
    warnings: step.warnings,
    errors: step.errors,
    nextActions: step.nextActions,
  };
}

function fail(
  code: string,
  message: string,
  data?: CategoryInspectResult,
): CommandResult<CategoryInspectResult> {
  return {
    ok: false,
    command: 'workflow.category.inspect',
    ...(data ? { data } : {}),
    warnings: [],
    errors: [{ code, message, recoverable: true }],
    nextActions: [],
  };
}

function workspaceFailure(
  source: SourcingResultV2,
  decision: CategoryDecisionV1,
  error: unknown,
): CommandResult<CategoryInspectResult> {
  return fail(
    'PRODUCT_WORKSPACE_WRITE_FAILED',
    error instanceof Error ? error.message : String(error),
    { source, category_decision: decision },
  );
}

export type { CanonicalProductV2 };

function isSourcingResultV2(value: unknown): value is SourcingResultV2 {
  return !!value && typeof value === 'object' &&
    (value as { schema_version?: unknown }).schema_version === 2;
}
