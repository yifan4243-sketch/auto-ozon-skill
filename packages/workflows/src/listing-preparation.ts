import type {
  AttributeMappingAgentInputV1,
  AttributeMappingV2,
  CanonicalProductV2,
  CategoryAttributesGroupV1,
  CategoryDecisionV1,
  CategoryDecisionAgentTaskV1,
  CommandResult,
  ContentBundleV1,
  CostPricingAgentInputV1,
  CostPricingFxRateV1,
  CostPricingPackageInputV1,
  CostPricingProfileV1,
  CostPricingV1,
  DraftGenerationProfileV1,
  ListingDraftV2,
  ImageBundleV1,
  ImageGenerationProviderV1,
  ImageReviewAgentInputV1,
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
  flattenOzonCategoryTree,
  loadOzonCategoryTree,
  runCategoryDecision,
  searchOzonCategories,
  type CategoryDecisionProvider,
} from '@auto-ozon/step-category-decision';
import {
  runCategoryAttributes,
  type RunCategoryAttributesInput,
} from '@auto-ozon/step-category-attributes';
import { buildContentBundle, runAttributeMapping } from '@auto-ozon/step-attribute-mapping';
import {
  runCostPricing,
  type CostPricingFxRateProvider,
} from '@auto-ozon/step-cost-pricing';
import { runDraftGeneration } from '@auto-ozon/step-draft-generation';
import { runImagePipeline, type ImagePipelineGenerationOptionsV1 } from '@auto-ozon/image-pipeline';
import type { CollectedSourcingRun } from '@auto-ozon/adapters-1688';
import { loadOzonEnvironment, withOzonMcpCredentials } from '@auto-ozon/adapters-ozon';
import { EnvSecretProvider, FileStoreRegistry, resolveStoreCredentials } from '@auto-ozon/config';
import { LISTING_PREPARATION_ORDER } from './step-registry.js';
import { SqliteJobStore, type WorkflowJobStateStore } from '@auto-ozon/job-store';
import {
  PersistedArtifactValidationError,
  assertCriticalArtifact,
  validateListingDraftArtifact,
} from '@auto-ozon/artifact-validation';

export interface RunListingPreparationInput {
  run_id?: string;
  /** Store whose two SecretRefs are allowed into read-only Ozon MCP calls. */
  store_id?: string;
  source?: RunSource1688Input;
  category_decision_provider?: CategoryDecisionProvider;
  category_decision_file?: string;
  category_attributes?: Pick<RunCategoryAttributesInput, 'force_refresh' | 'transport'>;
  cost_pricing_profile?: Partial<CostPricingProfileV1>;
  cost_pricing_agent_input?: CostPricingAgentInputV1;
  cost_pricing_package_inputs?: CostPricingPackageInputV1[];
  cost_pricing_commission_snapshot?: unknown;
  cost_pricing_commission_snapshot_sha256?: string;
  cost_pricing_fx_rate?: CostPricingFxRateV1;
  cost_pricing_fx_provider?: CostPricingFxRateProvider;
  attribute_mapping_agent_input?: AttributeMappingAgentInputV1;
  draft_generation_profile?: DraftGenerationProfileV1;
  image_bundle?: ImageBundleV1;
  image_generation?: ImagePipelineGenerationOptionsV1;
  image_generation_provider?: ImageGenerationProviderV1;
  image_review_agent_input?: ImageReviewAgentInputV1;
  qualification?: {
    max_sku_per_product: number;
    price_min_cny: number | null;
    price_max_cny: number | null;
    require_image: boolean;
  };
  start_from?: WorkflowStepName;
  stop_after?: WorkflowStepName;
  force_steps?: WorkflowStepName[];
  stop_on_review?: boolean;
  artifact_store?: ArtifactStore;
  job_state_store?: WorkflowJobStateStore;
  logger?: WorkflowLogger;
  signal?: AbortSignal;
  /** Internal persistent relationship for batch orchestration. */
  job_id?: string;
  /** Internal source offer relationship for batch orchestration. */
  offer_id?: string;
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
  attribute_mapping?: AttributeMappingV2;
  content_bundle?: ContentBundleV1;
  image_bundle?: ImageBundleV1;
  listing_draft?: ListingDraftV2;
}

export async function runListingPreparation(
  input: RunListingPreparationInput,
): Promise<CommandResult<ListingPreparationResultV1>> {
  const artifactStore = input.artifact_store ?? new FileArtifactStore();
  const jobStateStore = input.job_state_store ?? new SqliteJobStore();
  const ownsJobStateStore = !input.job_state_store;
  const runId = input.run_id ?? createRunId();
  try {
    return await artifactStore.withRunLock(runId, () => executeListingPreparation({
        ...input,
        run_id: runId,
        artifact_store: artifactStore,
      }));
  } catch (error) {
    if (error instanceof PersistedArtifactValidationError) {
      return {
        ok: false,
        command: 'workflow.listing-preparation',
        warnings: [],
        errors: [{ code: error.code, message: error.message, detail: { artifact_kind: error.artifact_kind, validation_errors: error.validation_errors }, recoverable: true }],
        nextActions: ['Regenerate the invalid persisted artifact and resume the run.'],
      };
    }
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
  } finally {
    const manifest = await artifactStore.readManifest(runId).catch(() => null);
    if (manifest) await jobStateStore.mirrorManifest(manifest, input.job_id ?? null, input.offer_id ?? null);
    if (ownsJobStateStore) await jobStateStore.close();
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
  const legacyDraft = await store.read<unknown>(runId, 'draft-generation', 'listing-draft-v1.json');
  const currentDraft = await store.read<unknown>(runId, 'draft-generation', 'listing-draft-v2.json');
  if (legacyDraft && !currentDraft) {
    return workflowFailure(
      {
        run_id: runId,
        artifact_store: store,
        logger: input.logger ?? createFileWorkflowLogger(store.runsRoot, runId),
        force_refresh: false,
        signal: input.signal,
      },
      'LEGACY_DRAFT_CONTRACT_UNSUPPORTED',
      'This run contains ListingDraftV1. It remains read-only and cannot be resumed; start a new run for ListingDraftV2.',
    );
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

  await prepareStep(context, 'canonicalize-product', { schema_version: 2, qualification: input.qualification ?? null });
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
  const qualificationError = validateProductQualification(product, input.qualification);
  if (qualificationError) {
    await store.updateStep(runId, 'canonicalize-product', {
      status: 'blocked',
      error: { code: qualificationError.code, message: qualificationError.message, recoverable: false },
    });
    return workflowSuccess(context, 'canonicalize-product', result, 'blocked');
  }
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
      const categoryTask = await buildCategoryAgentTask(product);
      const output = await store.write(
        runId,
        'category-decision',
        'category-agent-task-v1.json',
        categoryTask,
      );
      await store.updateStep(runId, 'category-decision', {
        status: 'needs_review',
        output,
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
    package_inputs: input.cost_pricing_package_inputs,
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
      || input.cost_pricing_package_inputs
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
        package_inputs: input.cost_pricing_package_inputs,
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
    const runAttributes = () => runCategoryAttributes({
        category_decision: decision,
        force_refresh:
          shouldForce('category-attributes') || input.category_attributes?.force_refresh,
        transport: input.category_attributes?.transport,
      }, context);
    const step = input.category_attributes?.transport || !input.store_id
      ? await runAttributes()
      : await withSelectedStoreMcpCredentials(input.store_id, runAttributes);
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
  let mapping = await restore<AttributeMappingV2>(
    context,
    'attribute-mapping',
    'attribute-mapping-v2.json',
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
  const storedContentBundle = await store.read<unknown>(
    runId,
    'attribute-mapping',
    'content-bundle-v1.json',
  );
  if (!storedContentBundle && (await store.readManifest(runId))?.steps['attribute-mapping'].artifacts
    .some((artifact) => artifact.path.endsWith('/content-bundle-v1.json'))) {
    throw new PersistedArtifactValidationError(
      'CONTENT_BUNDLE_ARTIFACT_CORRUPTED',
      'content_bundle_v1',
      ['The manifest-recorded content bundle is unreadable or its integrity check failed.'],
    );
  }
  let contentBundle = storedContentBundle
    ? assertCriticalArtifact('content_bundle_v1', storedContentBundle)
    : null;
  if (!contentBundle || contentBundle.source_offer_id !== mapping.source_offer_id) {
    contentBundle = buildContentBundle(mapping);
    await store.write(
      runId,
      'attribute-mapping',
      'content-bundle-v1.json',
      contentBundle,
    );
  }
  result.content_bundle = contentBundle;
  const mappingStatus = mapping.status === 'completed' ? 'succeeded' : mapping.status;
  if (contentBundle.status === 'blocked') {
    await store.updateStep(runId, 'attribute-mapping', {
      status: 'blocked',
      error_code: 'CONTENT_BUNDLE_BLOCKED',
    });
    return workflowSuccess(context, 'attribute-mapping', result, 'blocked');
  }
  if (contentBundle.status === 'needs_review') {
    await store.updateStep(runId, 'attribute-mapping', {
      status: 'needs_review',
      error_code: 'CONTENT_AGENT_INPUT_REQUIRED',
    });
    return workflowSuccess(context, 'attribute-mapping', result, 'needs_review');
  }
  if (mappingStatus === 'blocked' || (mappingStatus === 'needs_review' && stopOnReview)) {
    return workflowSuccess(context, 'attribute-mapping', result, mappingStatus);
  }
  if (stopAfter === 'attribute-mapping') {
    return workflowSuccess(context, 'attribute-mapping', result, mappingStatus);
  }

  await prepareStep(context, 'draft-generation', {
    profile: input.draft_generation_profile,
    image_bundle: input.image_bundle,
    image_generation: input.image_generation,
    image_provider: input.image_generation_provider?.constructor.name ?? null,
    image_review_agent_input: input.image_review_agent_input,
    content_bundle: contentBundle,
  });
  let draft = await restore<ListingDraftV2>(
    context,
    'draft-generation',
    'listing-draft-v2.json',
    startFrom,
    shouldForce('draft-generation') || Boolean(input.draft_generation_profile) || Boolean(input.image_review_agent_input),
  );
  if (!draft) {
    await store.updateStep(runId, 'draft-generation', { status: 'running' });
    const imageBundle = input.image_bundle
      ? assertCriticalArtifact('image_bundle_v1', input.image_bundle)
      : await runImagePipeline({
      product,
      generation: input.image_generation,
      provider: input.image_generation_provider,
      agent_review: input.image_review_agent_input,
      signal: input.signal,
    });
    result.image_bundle = imageBundle;
    const imageOutput = await store.write(runId, 'draft-generation', 'image-bundle-v1.json', imageBundle);
    if (imageBundle.status !== 'completed') {
      await store.updateStep(runId, 'draft-generation', {
        status: imageBundle.status,
        output: imageOutput,
        error_code: imageBundle.status === 'blocked' ? 'IMAGE_BUNDLE_BLOCKED' : 'IMAGE_REVIEW_REQUIRED',
      });
      return workflowSuccess(context, 'draft-generation', result, imageBundle.status);
    }
    const step = await runDraftGeneration({
      product,
      category_decision: decision,
      category_attributes: attributes,
      cost_pricing: pricing,
      attribute_mapping: mapping,
      content_bundle: contentBundle,
      profile: input.draft_generation_profile,
      image_bundle: imageBundle,
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
    const value = await context.artifact_store.read<unknown>(context.run_id, step, file);
    if (value) return validateRestoredArtifact(file, value) as T;
    const kind = artifactKindForFile(file);
    if (kind) {
      throw new PersistedArtifactValidationError(
        `${artifactCodePrefix(kind)}_ARTIFACT_CORRUPTED`,
        kind,
        [`The reusable manifest artifact ${step}/${file} is unreadable or failed its size/SHA-256 check.`],
      );
    }
  }
  if (!force && beforeStart) {
    const recorded = manifest?.steps[step].artifacts.some((artifact) => artifact.path.endsWith(`/${file}`));
    if (recorded) {
      const value = await context.artifact_store.read<unknown>(context.run_id, step, file);
      if (value === null) {
        const kind = artifactKindForFile(file);
        if (kind) {
          throw new PersistedArtifactValidationError(
            `${artifactCodePrefix(kind)}_ARTIFACT_CORRUPTED`,
            kind,
            [`The manifest-recorded ${step}/${file} is unreadable or failed its size/SHA-256 check.`],
          );
        }
      } else {
        validateRestoredArtifact(file, value);
      }
    }
    throw new Error(`Cannot resume from ${startFrom}; ${step}/${file} is missing, damaged, stale, or incompatible.`);
  }
  return null;
}

function artifactKindForFile(file: string): string | null {
  switch (file) {
    case 'canonical-product-v2.json': return 'canonical_product_v2';
    case 'category-decision-v1.json': return 'category_decision_v1';
    case 'cost-pricing-v1.json': return 'cost_pricing_v1';
    case 'category-attributes-v1.json': return 'category_attributes_group_v1';
    case 'attribute-mapping-v2.json': return 'attribute_mapping_v2';
    case 'listing-draft-v2.json': return 'listing_draft_v2';
    default: return null;
  }
}

function artifactCodePrefix(kind: string): string {
  if (kind === 'listing_draft_v2') return 'DRAFT';
  return kind.replace(/_v\d+$/u, '').replace(/_group$/u, '').toUpperCase();
}

function validateRestoredArtifact(file: string, value: unknown): unknown {
  switch (file) {
    case 'canonical-product-v2.json': return assertCriticalArtifact('canonical_product_v2', value);
    case 'category-decision-v1.json': return assertCriticalArtifact('category_decision_v1', value);
    case 'cost-pricing-v1.json': return assertCriticalArtifact('cost_pricing_v1', value);
    case 'category-attributes-v1.json': return assertCriticalArtifact('category_attributes_group_v1', value);
    case 'attribute-mapping-v2.json': return assertCriticalArtifact('attribute_mapping_v2', value);
    case 'listing-draft-v2.json': {
      const validation = validateListingDraftArtifact(value);
      if (!validation.ok) throw new PersistedArtifactValidationError(validation.code, 'listing_draft_v2', validation.errors);
      return validation.value;
    }
    default: return value;
  }
}

async function withSelectedStoreMcpCredentials<T>(storeId: string, operation: () => Promise<T>): Promise<T> {
  const profile = new FileStoreRegistry().get(storeId);
  const credentials = resolveStoreCredentials(profile, new EnvSecretProvider(loadOzonEnvironment()));
  return withOzonMcpCredentials({
    OZON_CLIENT_ID: credentials.clientId,
    OZON_API_KEY: credentials.apiKey,
  }, operation);
}

function validateProductQualification(
  product: CanonicalProductV2,
  qualification: RunListingPreparationInput['qualification'],
): { code: string; message: string } | null {
  if (!qualification) return null;
  if (!Number.isSafeInteger(qualification.max_sku_per_product) || qualification.max_sku_per_product < 1) {
    return { code: 'QUALIFICATION_CONFIG_INVALID', message: 'max_sku_per_product must be a positive integer.' };
  }
  if ((qualification.price_min_cny !== null && (!Number.isFinite(qualification.price_min_cny) || qualification.price_min_cny < 0))
    || (qualification.price_max_cny !== null && (!Number.isFinite(qualification.price_max_cny) || qualification.price_max_cny <= 0))
    || (qualification.price_min_cny !== null && qualification.price_max_cny !== null && qualification.price_min_cny > qualification.price_max_cny)) {
    return { code: 'QUALIFICATION_CONFIG_INVALID', message: 'Purchase-price bounds are invalid.' };
  }
  if (product.skus.length > qualification.max_sku_per_product) {
    return { code: 'SKU_COUNT_EXCEEDED', message: `Product has ${product.skus.length} SKU(s); maximum is ${qualification.max_sku_per_product}.` };
  }
  for (const sku of product.skus) {
    if (!Number.isFinite(sku.price_cny) || sku.price_cny! <= 0) {
      return { code: 'PURCHASE_PRICE_INVALID', message: `SKU ${sku.source_sku_id} has no valid purchase price.` };
    }
    if (qualification.price_min_cny !== null && sku.price_cny! < qualification.price_min_cny) {
      return { code: 'PURCHASE_PRICE_BELOW_MINIMUM', message: `SKU ${sku.source_sku_id} is below the configured purchase-price minimum.` };
    }
    if (qualification.price_max_cny !== null && sku.price_cny! > qualification.price_max_cny) {
      return { code: 'PURCHASE_PRICE_ABOVE_MAXIMUM', message: `SKU ${sku.source_sku_id} exceeds the configured purchase-price maximum.` };
    }
  }
  if (qualification.require_image && !product.product.main_image
    && product.product.gallery_images.length === 0
    && product.skus.every((sku) => !sku.image)) {
    return { code: 'PRODUCT_IMAGE_MISSING', message: 'Product has no usable source image.' };
  }
  const riskText = `${product.product.title_zh} ${product.source.source_category_path_zh.join(' ')} ${Object.entries(product.product.attributes).map(([key, value]) => `${key} ${value}`).join(' ')}`;
  if (/药品|医疗器械|食品|饮料|酒|烟草|电子烟|成人用品|武器|易燃|爆炸|活体|种子|农药|杀虫剂|液体香水|婴儿配方|电池|蓄电池/iu.test(riskText)) {
    return { code: 'PROHIBITED_PRODUCT_RISK', message: 'Product facts match the conservative prohibited/high-risk sourcing policy.' };
  }
  return null;
}

async function buildCategoryAgentTask(product: CanonicalProductV2): Promise<CategoryDecisionAgentTaskV1> {
  const tree = await loadOzonCategoryTree();
  const index = flattenOzonCategoryTree(tree);
  const queries = [...new Set([
    product.source.discovery_context.search_term,
    ...product.source.source_category_path_zh.slice().reverse(),
  ].map((value) => value?.normalize('NFKC').trim()).filter((value): value is string => Boolean(value)))].slice(0, 8);
  return {
    schema_version: 1,
    execution_owner: 'current_agent',
    source_offer_id: product.source.offer_id,
    category_snapshot: tree.snapshot,
    evidence: {
      search_term: product.source.discovery_context.search_term,
      title_zh: product.product.title_zh,
      source_category_path_zh: [...product.source.source_category_path_zh],
      product_attributes: { ...product.product.attributes },
      skus: product.skus.map((sku) => ({
        source_sku_id: sku.source_sku_id,
        raw_spec_text: sku.raw_spec_text,
        specs: { ...sku.specs },
        image: sku.image,
      })),
    },
    initial_candidate_sets: queries.map((query) => ({
      query,
      candidates: searchOzonCategories(index, query, 20).map(({ disabled: _disabled, ...candidate }) => candidate),
    })),
    instruction: 'Classify product structure, search additional short semantic nouns when needed, select only validated current-snapshot category pairs, and assign every source SKU exactly once in CategoryDecisionV1.',
  };
}

const STEP_IMPLEMENTATION_VERSIONS: Record<WorkflowStepName, string> = {
  'source-1688': '1',
  'canonicalize-product': '2',
  'category-decision': '1',
  'cost-pricing': '2',
  'category-attributes': '1',
  'attribute-mapping': '2',
  'draft-generation': '2',
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
      .map((dependency) => {
        const artifacts = manifest?.steps[dependency].artifacts ?? [];
        return [dependency, artifacts.length > 0
          ? hashWorkflowValue(artifacts.map((artifact) => ({ path: artifact.path, sha256: artifact.sha256 })))
          : undefined] as const;
      })
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
