import type {
  AttributeMappingAgentInputV1,
  AttributeMappingV1,
  AttributeMappingV2,
  CanonicalProductV2,
  CategoryAttributesGroupV1,
  CategoryDecisionV1,
  CommandResult,
  OzonDraftContentInputV1,
  OzonProductDraftV2,
  ListingPayloadV1,
  OzonPublishResultV1,
  StorePublishProfileV1,
  WorkflowRunManifestV2,
  WorkflowStepName,
  WorkflowStepStatus,
} from '@auto-ozon/contracts';
import {
  FileArtifactStore,
  createFileWorkflowLogger,
  createRunId,
  sha256Json,
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
import { runAttributeMappingV2 } from '@auto-ozon/step-attribute-mapping';
import { runDraftGenerationV2 } from '@auto-ozon/step-draft-generation';
import { runListingPayload } from '@auto-ozon/step-listing-payload';
import { runOzonPublish } from '@auto-ozon/step-ozon-publish';
import type { OzonSellerWriteTransport } from '@auto-ozon/adapters-ozon';
import type { CollectedSourcingRun } from '@auto-ozon/adapters-1688';
import { LISTING_PREPARATION_ORDER } from './step-registry.js';

const LAST_IMPLEMENTED_STEP: WorkflowStepName = 'ozon-publish';

export interface RunListingPreparationInput {
  run_id?: string;
  source?: RunSource1688Input;
  category_decision_provider?: CategoryDecisionProvider;
  category_decision_file?: string;
  category_attributes?: Pick<RunCategoryAttributesInput, 'force_refresh' | 'transport'>;
  attribute_mapping_agent_input?: AttributeMappingAgentInputV1;
  draft_content?: OzonDraftContentInputV1;
  publish_profile?: StorePublishProfileV1;
  ozon_write_transport?: OzonSellerWriteTransport;
  previous_publish_result?: OzonPublishResultV1;
  products_dir?: string;
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
  category_attributes?: CategoryAttributesGroupV1[];
  attribute_mapping?: AttributeMappingV2;
  draft?: OzonProductDraftV2;
  listing_payload?: ListingPayloadV1;
  publish_result?: OzonPublishResultV1;
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
    try { await artifactStore.ensureRun(runId); } catch { /* preserve the original error */ }
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
  const context: WorkflowContext = {
    run_id: runId,
    artifact_store: store,
    logger: input.logger ?? createFileWorkflowLogger(store.runsRoot, runId),
    force_refresh: false,
    signal: input.signal,
  };
  context.logger.info('listing-preparation started', {
    start_from: input.start_from ?? 'source-1688',
    stop_after: input.stop_after ?? 'attribute-mapping',
    force_steps: input.force_steps ?? [],
  });
  const stopAfter = input.stop_after ?? 'attribute-mapping';
  if (stepIndex(stopAfter) > stepIndex(LAST_IMPLEMENTED_STEP)) {
    return workflowFailure(context, 'STEP_NOT_ENABLED', `Step ${stopAfter} is not enabled.`);
  }
  const startFrom = input.start_from ?? 'source-1688';
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
    await store.markStaleFrom(runId, LISTING_PREPARATION_ORDER[earliestForce]!);
  }
  const stopOnReview = input.stop_on_review ?? true;
  const result: Omit<ListingPreparationResultV1, 'manifest' | 'status' | 'stopped_after'> = {
    schema_version: 1,
    run_id: runId,
  };

  let source = await restore<CollectedSourcingRun>(
    context,
    'source-1688',
    'offer-result.json',
    startFrom,
    shouldForce('source-1688'),
    input.source,
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
    await recordProvenance(context, 'source-1688', input.source, []);
  }
  result.source = source;
  if (stopAfter === 'source-1688') return workflowSuccess(context, 'source-1688', result);

  let product = await restore<CanonicalProductV2>(
    context,
    'canonicalize-product',
    'canonical-product-v2.json',
    startFrom,
    shouldForce('canonicalize-product'),
    { source },
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
    await recordProvenance(context, 'canonicalize-product', { source }, ['source-1688']);
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

  let decision = await restore<CategoryDecisionV1>(
    context,
    'category-decision',
    'category-decision-v1.json',
    startFrom,
    shouldForce('category-decision'),
    { product },
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
    } else {
      const step = await runCategoryDecision(
        { product, provider: decisionProvider },
        context,
      );
      if (!step.data || !step.ok) {
        return stopFromStep(context, 'category-decision', step, result);
      }
      decision = step.data;
      await recordProvenance(context, 'category-decision', { product }, ['canonicalize-product']);
    }
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

  let attributes = await restore<CategoryAttributesGroupV1[]>(
    context,
    'category-attributes',
    'category-attributes-v1.json',
    startFrom,
    shouldForce('category-attributes'),
    { decision },
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
    await recordProvenance(context, 'category-attributes', { decision }, ['category-decision']);
  }
  result.category_attributes = attributes;
  if (stopAfter === 'category-attributes') {
    return workflowSuccess(context, 'category-attributes', result);
  }

  let mapping = await restore<AttributeMappingV2>(
    context,
    'attribute-mapping',
    'attribute-mapping-v2.json',
    startFrom,
    shouldForce('attribute-mapping'),
    { product, decision, attributes, agent_input: input.attribute_mapping_agent_input },
  );
  if (!mapping) {
    const step = await runAttributeMappingV2(
      {
        product,
        category_decision: decision,
        category_attributes: attributes,
        agent_input: input.attribute_mapping_agent_input,
      },
      context,
    );
    if (!step.data || !step.ok) {
      return stopFromStep(context, 'attribute-mapping', step, result);
    }
    mapping = step.data;
    await recordProvenance(context, 'attribute-mapping',
      { product, decision, attributes, agent_input: input.attribute_mapping_agent_input },
      ['canonicalize-product', 'category-decision', 'category-attributes']);
  }
  result.attribute_mapping = mapping;
  const mappingStatus = mapping.status === 'completed' ? 'succeeded' : mapping.status;
  if (mappingStatus === 'blocked' || (mappingStatus === 'needs_review' && stopOnReview)) {
    return workflowSuccess(context, 'attribute-mapping', result, mappingStatus);
  }
  if (stopAfter === 'attribute-mapping') {
    return workflowSuccess(context, 'attribute-mapping', result, mappingStatus);
  }

  let draft = await restore<OzonProductDraftV2>(
    context,
    'draft-generation',
    'product-draft-v2.json',
    startFrom,
    shouldForce('draft-generation'),
    { product, decision, attributes, mapping, content: input.draft_content },
  );
  if (!draft) {
    if (!input.draft_content) {
      await store.updateStep(runId, 'draft-generation', {
        status: 'needs_review', error_code: 'DRAFT_CONTENT_REQUIRED',
      });
      return workflowSuccess(context, 'draft-generation', result, 'needs_review');
    }
    const step = await runDraftGenerationV2(
      {
        attribute_mapping: mapping,
        category_attributes: attributes,
        content: input.draft_content,
        product,
        category_decision: decision,
        products_dir: input.products_dir,
      },
      context,
    );
    if (!step.data || !step.ok) {
      return stopFromStep(context, 'draft-generation', step, result);
    }
    draft = step.data;
    await recordProvenance(context, 'draft-generation',
      { product, decision, attributes, mapping, content: input.draft_content },
      ['canonicalize-product', 'category-decision', 'category-attributes', 'attribute-mapping']);
  }
  result.draft = draft;
  const draftStatus = draft.status === 'draft_complete' ? 'succeeded' : draft.status;
  if (draft.publish_readiness !== 'ready' || (draftStatus === 'needs_review' && stopOnReview)) {
    return workflowSuccess(context, 'draft-generation', result, draftStatus);
  }
  if (stopAfter === 'draft-generation') return workflowSuccess(context, 'draft-generation', result, draftStatus);

  if (!input.publish_profile) return workflowFailure(context, 'PUBLISH_PROFILE_REQUIRED', 'A validated store publish profile is required.', result);
  let payload = await restore<ListingPayloadV1>(context, 'listing-payload', 'listing-payload-v1.json', startFrom, shouldForce('listing-payload'), { product, draft, profile: input.publish_profile });
  if (!payload) {
    const step = await runListingPayload({ run_id: runId, product, draft, profile: input.publish_profile }, context);
    if (!step.data || !step.ok) return stopFromStep(context, 'listing-payload', step, result);
    payload = step.data;
    await recordProvenance(context, 'listing-payload', { product, draft, profile: input.publish_profile }, ['canonicalize-product', 'draft-generation']);
  }
  result.listing_payload = payload;
  if (stopAfter === 'listing-payload') return workflowSuccess(context, 'listing-payload', result);

  if (!input.ozon_write_transport) return workflowFailure(context, 'OZON_WRITE_TRANSPORT_REQUIRED', 'Typed Ozon write transport is required for publishing.', result);
  let publishResult = await restore<OzonPublishResultV1>(context, 'ozon-publish', 'ozon-publish-result-v1.json', startFrom, shouldForce('ozon-publish'), { payload, profile: input.publish_profile });
  if (!publishResult) {
    const step = await runOzonPublish({ payload, profile: input.publish_profile, transport: input.ozon_write_transport, previous_result: input.previous_publish_result, signal: input.signal }, context);
    if (!step.data) return stopFromStep(context, 'ozon-publish', step, result);
    publishResult = step.data;
    await recordProvenance(context, 'ozon-publish', { payload, profile: input.publish_profile }, ['listing-payload']);
  }
  result.publish_result = publishResult;
  return workflowSuccess(context, 'ozon-publish', result, publishResult.status === 'succeeded' ? 'succeeded' : 'failed');
}


async function restore<T>(
  context: WorkflowContext,
  step: WorkflowStepName,
  file: string,
  startFrom: WorkflowStepName,
  force: boolean,
  expectedInput?: unknown,
): Promise<T | null> {
  let manifest = await context.artifact_store.readManifest(context.run_id);
  const record = manifest?.steps[step];
  const beforeStart = stepIndex(step) < stepIndex(startFrom);
  const reusable = record && ['succeeded', 'needs_review', 'skipped'].includes(record.status);
  if (!force && record && (beforeStart || reusable)) {
    const inputMatches = expectedInput === undefined || record.input_sha256 === null ||
      record.input_sha256 === sha256Json(expectedInput);
    const dependenciesMatch = Object.entries(record.dependency_sha256).every(([name, digest]) =>
      manifest?.steps[name as WorkflowStepName]?.artifact?.sha256 === digest);
    if (!inputMatches || !dependenciesMatch) {
      manifest = await context.artifact_store.markStaleFrom(context.run_id, step);
      if (beforeStart) throw new Error(`Cannot resume from ${startFrom}; ${step} inputs or dependencies changed.`);
      return null;
    }
    const value = await context.artifact_store.read<T>(context.run_id, step, file);
    if (value) return value;
    if (beforeStart) {
      throw new Error(`Cannot resume from ${startFrom}; ${step}/${file} is missing.`);
    }
  }
  return null;
}

async function recordProvenance(
  context: WorkflowContext,
  step: WorkflowStepName,
  input: unknown,
  dependencies: WorkflowStepName[],
): Promise<void> {
  const manifest = await context.artifact_store.readManifest(context.run_id);
  if (!manifest) throw new Error(`Run ${context.run_id} has no manifest.`);
  const dependencySha256 = Object.fromEntries(dependencies.map((name) => {
    const digest = manifest.steps[name].artifact?.sha256;
    if (!digest) throw new Error(`Step ${step} cannot record missing dependency artifact ${name}.`);
    return [name, digest];
  }));
  await context.artifact_store.updateStep(context.run_id, step, {
    status: manifest.steps[step].status,
    input_sha256: sha256Json(input),
    dependency_sha256: dependencySha256,
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
