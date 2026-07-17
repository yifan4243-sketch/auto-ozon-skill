import type {
  AttributeMappingAgentInputV1,
  AttributeMappingV1,
  CanonicalProductV2,
  CategoryAttributesGroupV1,
  CategoryDecisionV1,
  CommandResult,
  CostPricingAgentInputV1,
  CostPricingFxRateV1,
  CostPricingProfileV1,
  CostPricingV1,
  DraftGenerationProfileV1,
  ListingDraftV1,
  WorkflowRunManifestV2,
  WorkflowStepName,
  WorkflowStepStatus,
} from '@auto-ozon/contracts';
import {
  ArtifactStoreError,
  FileArtifactStore,
  createFileWorkflowLogger,
  createRunId,
  hashWorkflowValue,
  type ArtifactStore,
  type WorkflowContext,
  type WorkflowLogger,
} from '@auto-ozon/artifact-store';
import {
  runSource1688,
  type RunSource1688Input,
} from '@auto-ozon/step-source-1688';
import { runCanonicalizeProduct } from '@auto-ozon/step-canonicalize-product';
import {
  FileDecisionProvider,
  runCategoryDecision,
  type CategoryDecisionProvider,
} from '@auto-ozon/step-category-decision';
import {
  runCategoryAttributes,
  type RunCategoryAttributesInput,
} from '@auto-ozon/step-category-attributes';
import { runAttributeMapping } from '@auto-ozon/step-attribute-mapping';
import {
  runCostPricing,
  type CostPricingFxRateProvider,
} from '@auto-ozon/step-cost-pricing';
import { runDraftGeneration } from '@auto-ozon/step-draft-generation';
import type { CollectedSourcingRun } from '@auto-ozon/adapters-1688';
import { LISTING_PREPARATION_ORDER } from './step-registry.js';

export interface RunListingPreparationInput {
  run_id?: string;
  source?: RunSource1688Input;
  category_decision_provider?: CategoryDecisionProvider;
  category_decision_file?: string;
  category_attributes?: Pick<RunCategoryAttributesInput, 'force_refresh' | 'transport'>;
  cost_pricing_profile?: Partial<CostPricingProfileV1>;
  cost_pricing_agent_input?: CostPricingAgentInputV1;
  cost_pricing_commission_snapshot?: unknown;
  cost_pricing_commission_snapshot_sha256?: string;
  cost_pricing_fx_rate?: CostPricingFxRateV1;
  cost_pricing_fx_provider?: CostPricingFxRateProvider;
  attribute_mapping_agent_input?: AttributeMappingAgentInputV1;
  draft_generation_profile?: DraftGenerationProfileV1;
  start_from?: WorkflowStepName;
  stop_after?: WorkflowStepName;
  force_steps?: WorkflowStepName[];
  stop_on_review?: boolean;
  artifact_store?: ArtifactStore;
  logger?: WorkflowLogger;
  signal?: AbortSignal;
}

export interface ListingPreparationResultV1 {
  schema_version: 1;
  run_id: string;
  status: WorkflowStepStatus;
  stopped_after: WorkflowStepName | null;
  manifest: WorkflowRunManifestV2;
  source?: CollectedSourcingRun;
  product?: CanonicalProductV2;
  category_decision?: CategoryDecisionV1;
  cost_pricing?: CostPricingV1;
  category_attributes?: CategoryAttributesGroupV1[];
  attribute_mapping?: AttributeMappingV1;
  listing_draft?: ListingDraftV1;
}

export async function runListingPreparation(
  input: RunListingPreparationInput,
): Promise<CommandResult<ListingPreparationResultV1>> {
  const artifactStore = input.artifact_store ?? new FileArtifactStore();
  const runId = input.run_id ?? createRunId();
  try {
    return await artifactStore.withRunLock(runId, () => executeListingPreparation({
        ...input,
        run_id: runId,
        artifact_store: artifactStore,
      }));
  } catch (error) {
    if (error instanceof ArtifactStoreError) {
      return {
        ok: false,
        command: 'workflow.listing-preparation',
        warnings: [],
        errors: [{ code: error.code, message: error.message, recoverable: error.code !== 'MANIFEST_INVALID' }],
        nextActions: error.code === 'LEGACY_RUN_UNSUPPORTED' ? ['Start a new run. The legacy run was not modified.'] : [],
      };
    }
    await artifactStore.ensureRun(runId);
    return workflowFailure(
      {
        run_id: runId,
        artifact_store: artifactStore,
        logger: input.logger ?? createFileWorkflowLogger(artifactStore.runsRoot, runId),
        force_refresh: false,
        signal: input.signal,
      },
      'WORKFLOW_EXECUTION_FAILED',
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function executeListingPreparation(
  input: RunListingPreparationInput,
): Promise<CommandResult<ListingPreparationResultV1>> {
  const store = input.artifact_store ?? new FileArtifactStore();
  const runId = input.run_id ?? createRunId();
  await store.ensureRun(runId);
  const runManifest = await store.readManifest(runId);
  if (!runManifest || !Object.prototype.hasOwnProperty.call(runManifest.steps, 'draft-generation')) {
    return workflowFailure(
      {
        run_id: runId,
        artifact_store: store,
        logger: input.logger ?? createFileWorkflowLogger(store.runsRoot, runId),
        force_refresh: false,
        signal: input.signal,
      },
      'LEGACY_STEP_LAYOUT_UNSUPPORTED',
      'This run predates draft-generation and cannot be resumed. Start a new run; historical files were not changed.',
    );
  }
  const context: WorkflowContext = {
    run_id: runId,
    artifact_store: store,
    logger: input.logger ?? createFileWorkflowLogger(store.runsRoot, runId),
    force_refresh: false,
    signal: input.signal,
  };
  context.logger.info('listing-preparation started', {
    start_from: input.start_from ?? 'source-1688',
    stop_after: input.stop_after ?? 'draft-generation',
    force_steps: input.force_steps ?? [],
  });
  const stopAfter = input.stop_after ?? 'draft-generation';
  if (!LISTING_PREPARATION_ORDER.includes(stopAfter)) {
    return workflowFailure(context, 'STEP_NOT_ENABLED', `Step ${stopAfter} is not enabled.`);
  }
  const startFrom = input.start_from ?? 'source-1688';
  if (!LISTING_PREPARATION_ORDER.includes(startFrom)) {
    return workflowFailure(context, 'STEP_NOT_ENABLED', `Step ${startFrom} is not enabled.`);
  }
  const unsupportedForceStep = (input.force_steps ?? []).find(
    (step) => !LISTING_PREPARATION_ORDER.includes(step),
  );
  if (unsupportedForceStep) {
    return workflowFailure(context, 'STEP_NOT_ENABLED', `Step ${unsupportedForceStep} is not enabled.`);
  }
  if (stepIndex(startFrom) > stepIndex(stopAfter)) {
    return workflowFailure(
      context,
      'INVALID_STEP_RANGE',
      'start_from must not be after stop_after.',
    );
  }
  const forced = new Set(input.force_steps ?? []);
  const earliestForce = Math.min(
    ...[...forced].map(stepIndex),
    Number.POSITIVE_INFINITY,
  );
  const shouldForce = (step: WorkflowStepName) =>
    forced.has(step) || stepIndex(step) > earliestForce;
  if (Number.isFinite(earliestForce)) {
    await store.markDownstreamStale(runId, LISTING_PREPARATION_ORDER[earliestForce]!);
  }
  const stopOnReview = input.stop_on_review ?? true;
  const result: Omit<ListingPreparationResultV1, 'manifest' | 'status' | 'stopped_after'> = {
    schema_version: 1,
    run_id: runId,
  };

  await prepareStep(context, 'source-1688', input.source);
  let source = await restore<CollectedSourcingRun>(
    context,
    'source-1688',
    'offer-result.json',
    startFrom,
    shouldForce('source-1688'),
  );
  if (!source) {
    if (!input.source) {
      return workflowFailure(
        context,
        'SOURCE_INPUT_REQUIRED',
        'source input is required when no reusable source artifact exists.',
        result,
      );
    }
    const step = await runSource1688(input.source, context);
    if (!step.data || !step.ok) return stopFromStep(context, 'source-1688', step, result);
    source = step.data;
  }
  result.source = source;
  if (stopAfter === 'source-1688') return workflowSuccess(context, 'source-1688', result);

  await prepareStep(context, 'canonicalize-product', { schema_version: 2 });
  let product = await restore<CanonicalProductV2>(
    context,
    'canonicalize-product',
    'canonical-product-v2.json',
    startFrom,
    shouldForce('canonicalize-product'),
  );
  if (!product) {
    const step = await runCanonicalizeProduct(
      {
        source,
        schema_version: 2,
        command: `source.${source.mode}`,
      },
      context,
    );
    const items = step.data && 'schema_version' in step.data && step.data.schema_version === 2
      ? step.data.items
      : [];
    if (!step.ok || items.length !== 1) {
      return items.length !== 1
        ? workflowFailure(
            context,
            'SINGLE_PRODUCT_REQUIRED',
            `listing-preparation requires exactly one canonical product; received ${items.length}.`,
            result,
          )
        : stopFromStep(context, 'canonicalize-product', step, result);
    }
    product = items[0]!;
  }
  result.product = product;
  const canonicalStatus = product.validation.status === 'blocked'
    ? 'blocked'
    : product.validation.status === 'needs_review'
      ? 'needs_review'
      : 'succeeded';
  if (canonicalStatus === 'blocked' || (canonicalStatus === 'needs_review' && stopOnReview)) {
    return workflowSuccess(context, 'canonicalize-product', result, canonicalStatus);
  }
  if (stopAfter === 'canonicalize-product') {
    return workflowSuccess(context, 'canonicalize-product', result, canonicalStatus);
  }

  await prepareStep(context, 'category-decision', {
    decision_file: input.category_decision_file ?? null,
    provider: input.category_decision_provider?.constructor.name ?? null,
  });
  let decision = await restore<CategoryDecisionV1>(
    context,
    'category-decision',
    'category-decision-v1.json',
    startFrom,
    shouldForce('category-decision'),
  );
  if (!decision) {
    const decisionProvider = input.category_decision_provider ??
      (input.category_decision_file
        ? new FileDecisionProvider(input.category_decision_file)
        : undefined);
    if (!decisionProvider) {
      await store.updateStep(runId, 'category-decision', {
        status: 'needs_review',
        error_code: 'CATEGORY_DECISION_PROVIDER_REQUIRED',
      });
      return workflowSuccess(context, 'category-decision', result, 'needs_review');
    }
    const step = await runCategoryDecision(
      { product, provider: decisionProvider },
      context,
    );
    if (!step.data || !step.ok) {
      return stopFromStep(context, 'category-decision', step, result);
    }
    decision = step.data;
  }
  result.category_decision = decision;
  if (decision.status === 'blocked' || (decision.status === 'needs_review' && stopOnReview)) {
    return workflowSuccess(context, 'category-decision', result, decision.status);
  }
  if (stopAfter === 'category-decision') {
    return workflowSuccess(
      context,
      'category-decision',
      result,
      decision.status === 'decided' ? 'succeeded' : decision.status,
    );
  }

  await prepareStep(context, 'cost-pricing', {
    profile: input.cost_pricing_profile,
    agent_input: input.cost_pricing_agent_input,
    commission_snapshot_sha256: input.cost_pricing_commission_snapshot_sha256,
    fx_rate: input.cost_pricing_fx_rate,
  });
  const previousPricing = await store.read<CostPricingV1>(
    runId,
    'cost-pricing',
    'cost-pricing-v1.json',
  );
  let pricing = await restore<CostPricingV1>(
    context,
    'cost-pricing',
    'cost-pricing-v1.json',
    startFrom,
    shouldForce('cost-pricing') || Boolean(
      input.cost_pricing_agent_input
      || input.cost_pricing_profile
      || input.cost_pricing_commission_snapshot,
    ),
  );
  if (!pricing) {
    const step = await runCostPricing(
      {
        product,
        category_decision: decision,
        profile: input.cost_pricing_profile,
        agent_input: input.cost_pricing_agent_input ?? recoverPricingAgentInput(previousPricing),
        commission_snapshot: input.cost_pricing_commission_snapshot,
        commission_snapshot_sha256: input.cost_pricing_commission_snapshot_sha256,
        fx_rate: previousPricing?.fx_rate ?? input.cost_pricing_fx_rate ?? undefined,
        fx_provider: input.cost_pricing_fx_provider,
      },
      context,
    );
    if (!step.data || !step.ok) return stopFromStep(context, 'cost-pricing', step, result);
    pricing = step.data;
  }
  result.cost_pricing = pricing;
  const pricingStatus = pricing.status === 'completed'
    ? 'succeeded'
    : pricing.status === 'needs_agent'
      ? 'needs_review'
      : 'blocked';
  if (pricingStatus === 'blocked' || pricing.status === 'needs_agent') {
    return workflowSuccess(context, 'cost-pricing', result, pricingStatus);
  }
  if (stopAfter === 'cost-pricing') {
    return workflowSuccess(context, 'cost-pricing', result, pricingStatus);
  }

  await prepareStep(context, 'category-attributes', {
    force_refresh: Boolean(input.category_attributes?.force_refresh),
  });
  let attributes = await restore<CategoryAttributesGroupV1[]>(
    context,
    'category-attributes',
    'category-attributes-v1.json',
    startFrom,
    shouldForce('category-attributes'),
  );
  if (!attributes) {
    const step = await runCategoryAttributes(
      {
        category_decision: decision,
        force_refresh:
          shouldForce('category-attributes') || input.category_attributes?.force_refresh,
        transport: input.category_attributes?.transport,
      },
      context,
    );
    if (!step.data || !step.ok) {
      return stopFromStep(context, 'category-attributes', step, result);
    }
    attributes = step.data;
  }
  result.category_attributes = attributes;
  if (stopAfter === 'category-attributes') {
    return workflowSuccess(context, 'category-attributes', result);
  }

  await prepareStep(context, 'attribute-mapping', input.attribute_mapping_agent_input);
  let mapping = await restore<AttributeMappingV1>(
    context,
    'attribute-mapping',
    'attribute-mapping-v1.json',
    startFrom,
    shouldForce('attribute-mapping') || Boolean(input.attribute_mapping_agent_input),
  );
  if (!mapping) {
    const step = await runAttributeMapping(
      {
        product,
        category_decision: decision,
        category_attributes: attributes,
        cost_pricing: pricing,
        agent_input: input.attribute_mapping_agent_input,
      },
      context,
    );
    if (!step.data || !step.ok) {
      return stopFromStep(context, 'attribute-mapping', step, result);
    }
    mapping = step.data;
  }
  result.attribute_mapping = mapping;
  const mappingStatus = mapping.status === 'completed' ? 'succeeded' : mapping.status;
  if (mappingStatus === 'blocked' || (mappingStatus === 'needs_review' && stopOnReview)) {
    return workflowSuccess(context, 'attribute-mapping', result, mappingStatus);
  }
  if (stopAfter === 'attribute-mapping') {
    return workflowSuccess(context, 'attribute-mapping', result, mappingStatus);
  }

  await prepareStep(context, 'draft-generation', input.draft_generation_profile);
  let draft = await restore<ListingDraftV1>(
    context,
    'draft-generation',
    'listing-draft-v1.json',
    startFrom,
    shouldForce('draft-generation') || Boolean(input.draft_generation_profile),
  );
  if (!draft) {
    const step = await runDraftGeneration({
      product,
      category_decision: decision,
      category_attributes: attributes,
      cost_pricing: pricing,
      attribute_mapping: mapping,
      profile: input.draft_generation_profile,
    }, context);
    if (!step.data || !step.ok) return stopFromStep(context, 'draft-generation', step, result);
    draft = step.data;
  }
  const resolvedDraft = draft!;
  result.listing_draft = resolvedDraft;
  const draftStatus = resolvedDraft.status === 'draft_complete' ? 'succeeded' : resolvedDraft.status;
  return workflowSuccess(context, 'draft-generation', result, draftStatus);
}

function recoverPricingAgentInput(pricing: CostPricingV1 | null): CostPricingAgentInputV1 | undefined {
  if (!pricing || pricing.status !== 'completed') return undefined;
  const skuInputs = pricing.sku_pricing
    .filter((sku) => sku.package.source === 'agent_estimated')
    .map((sku) => ({
      source_sku_id: sku.source_sku_id,
      packaged_weight_g: sku.package.source_weight_g,
      length_cm: sku.package.length_cm,
      width_cm: sku.package.width_cm,
      height_cm: sku.package.height_cm,
      rationale: 'Reused the audited Agent package estimate from this run.',
      evidence: sku.package.evidence,
    }));
  return skuInputs.length > 0
    ? { source_offer_id: pricing.source_offer_id, sku_inputs: skuInputs }
    : undefined;
}

async function restore<T>(
  context: WorkflowContext,
  step: WorkflowStepName,
  file: string,
  startFrom: WorkflowStepName,
  force: boolean,
): Promise<T | null> {
  const manifest = await context.artifact_store.readManifest(context.run_id);
  const beforeStart = stepIndex(step) < stepIndex(startFrom);
  const reusable = await context.artifact_store.isReusable(context.run_id, step);
  if (!force && reusable) {
    const value = await context.artifact_store.read<T>(context.run_id, step, file);
    if (value) return value;
  }
  if (!force && beforeStart) {
    throw new Error(`Cannot resume from ${startFrom}; ${step}/${file} is missing, damaged, stale, or incompatible.`);
  }
  return null;
}

const STEP_IMPLEMENTATION_VERSIONS: Record<WorkflowStepName, string> = {
  'source-1688': '1',
  'canonicalize-product': '2',
  'category-decision': '1',
  'cost-pricing': '1',
  'category-attributes': '1',
  'attribute-mapping': '1',
  'draft-generation': '1',
  'listing-submit': '1',
};

async function prepareStep(
  context: WorkflowContext,
  step: WorkflowStepName,
  input: unknown,
): Promise<void> {
  const manifest = await context.artifact_store.readManifest(context.run_id);
  const index = stepIndex(step);
  const dependencyHashes = Object.fromEntries(
    LISTING_PREPARATION_ORDER.slice(0, index)
      .map((dependency) => [dependency, manifest?.steps[dependency].artifact?.sha256] as const)
      .filter((entry): entry is readonly [WorkflowStepName, string] => Boolean(entry[1])),
  );
  await context.artifact_store.prepareStep(context.run_id, step, {
    ...(input === undefined ? {} : { input_hash: hashWorkflowValue(input) }),
    dependency_hashes: dependencyHashes,
    implementation_version: STEP_IMPLEMENTATION_VERSIONS[step],
  });
}

function stepIndex(step: WorkflowStepName): number {
  const index = LISTING_PREPARATION_ORDER.indexOf(step);
  if (index < 0) throw new Error(`Unknown listing-preparation step: ${step}`);
  return index;
}

async function workflowSuccess(
  context: WorkflowContext,
  stoppedAfter: WorkflowStepName,
  partial: Omit<ListingPreparationResultV1, 'manifest' | 'status' | 'stopped_after'>,
  status: WorkflowStepStatus = 'succeeded',
): Promise<CommandResult<ListingPreparationResultV1>> {
  const manifest = (await context.artifact_store.readManifest(context.run_id))!;
  context.logger.info('listing-preparation stopped', { stopped_after: stoppedAfter, status });
  return {
    ok: status !== 'blocked' && status !== 'failed',
    command: 'workflow.listing-preparation',
    data: { ...partial, status, stopped_after: stoppedAfter, manifest },
    warnings: status === 'needs_review'
      ? [{ code: 'WORKFLOW_NEEDS_REVIEW', message: `Review required after ${stoppedAfter}.` }]
      : [],
    errors: [],
    nextActions: status === 'needs_review'
      ? [`Review ${stoppedAfter} artifacts, then resume this run.`]
      : [],
  };
}

async function workflowFailure(
  context: WorkflowContext,
  code: string,
  message: string,
  partial: Omit<ListingPreparationResultV1, 'manifest' | 'status' | 'stopped_after'> = {
    schema_version: 1,
    run_id: context.run_id,
  },
): Promise<CommandResult<ListingPreparationResultV1>> {
  const manifest = (await context.artifact_store.readManifest(context.run_id))!;
  context.logger.error(message, { code });
  return {
    ok: false,
    command: 'workflow.listing-preparation',
    data: { ...partial, status: 'failed', stopped_after: manifest.current_step, manifest },
    warnings: [],
    errors: [{ code, message, recoverable: true }],
    nextActions: [],
  };
}

async function stopFromStep(
  context: WorkflowContext,
  step: WorkflowStepName,
  command: CommandResult<unknown>,
  partial: Omit<ListingPreparationResultV1, 'manifest' | 'status' | 'stopped_after'>,
): Promise<CommandResult<ListingPreparationResultV1>> {
  const manifest = (await context.artifact_store.readManifest(context.run_id))!;
  const status = manifest.steps[step].status;
  return {
    ok: false,
    command: 'workflow.listing-preparation',
    data: { ...partial, status, stopped_after: step, manifest },
    warnings: command.warnings,
    errors: command.errors,
    nextActions: command.nextActions,
  };
}
