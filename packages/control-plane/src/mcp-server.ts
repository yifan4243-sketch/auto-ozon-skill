import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AgentDecisionEnvelopeV1, CategoryDecisionAgentTaskV1, CommandResult, WorkflowStepName } from '@auto-ozon/contracts';
import { FileArtifactStore } from '@auto-ozon/artifact-store';
import { FileBatchStore } from '@auto-ozon/batch-orchestrator';
import {
  createBatchWorkflow,
  getBatchWorkflowStatus,
  getListingPublishStatus,
  runBatchWorkflow,
  runListingPublish,
  runSetupDoctor,
  refreshOzonCategoryTree,
  submitBatchAgentInput,
} from '@auto-ozon/workflows';
import {
  flattenOzonCategoryTree,
  loadOzonCategoryTree,
  searchOzonCategories,
  validateOzonCategoryPair,
} from '@auto-ozon/step-category-decision';

export function createAutoOzonMcpServer(): McpServer {
  const server = new McpServer({ name: 'auto-ozon-control-plane', version: '1.0.0' });

  server.registerTool('auto_ozon.setup.status', {
    title: 'Auto Ozon setup status',
    description: 'Return a read-only, redacted readiness report. Never returns API keys or cookies.',
    annotations: readOnlyAnnotations(),
  }, async () => toolResult(await runSetupDoctor()));

  server.registerTool('auto_ozon.job.create', {
    title: 'Create listing batch',
    description: 'Create a foreground batch. A keyword routes directly; omitted keyword uses Russian market selection.',
    inputSchema: z.object({
      batch_id: safeId(), store_id: safeId(), requested_listing_count: z.number().int().min(1).max(100),
      keyword: z.string().trim().min(1).optional(), profiles: z.array(profileName()).min(2),
      headed: z.boolean(), captcha_policy: z.enum(['pause', 'skip_product']),
      max_sku_per_product: z.number().int().min(1).max(100),
      price_min_cny: z.number().nonnegative().nullable(), price_max_cny: z.number().positive().nullable(),
      candidate_limit: z.number().int().min(1).max(1000), category_count: z.number().int().min(5).max(10).optional(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => toolResult(await createBatchWorkflow({
    ...input,
    profiles: input.profiles as [string, string, ...string[]],
  })));

  server.registerTool('auto_ozon.category.refresh', {
    title: 'Refresh Ozon category snapshot',
    description: 'Refresh the Chinese category tree through the fixed read-only Seller endpoint and write a versioned local cache.',
    inputSchema: z.object({ store_id: safeId() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ store_id }) => toolResult(await refreshOzonCategoryTree({ store_id })));

  server.registerTool('auto_ozon.category.search', {
    title: 'Search current Ozon category snapshot',
    description: 'Search short Chinese semantic nouns in the fixed current category snapshot. Returns only enabled category/type pairs.',
    inputSchema: z.object({ query: z.string().trim().min(1).max(80), limit: z.number().int().min(1).max(40).default(20) }),
    annotations: readOnlyAnnotations(),
  }, async ({ query, limit }) => {
    const tree = await loadOzonCategoryTree();
    return toolResult({ schema_version: 1, snapshot: tree.snapshot, query, candidates: searchOzonCategories(flattenOzonCategoryTree(tree), query, limit) });
  });

  server.registerTool('auto_ozon.category.validate', {
    title: 'Validate Ozon category pair',
    description: 'Validate one description_category_id and type_id pair against the fixed current category snapshot.',
    inputSchema: z.object({ description_category_id: z.number().int().positive(), type_id: z.number().int().positive() }),
    annotations: readOnlyAnnotations(),
  }, async ({ description_category_id, type_id }) => {
    const tree = await loadOzonCategoryTree();
    return toolResult({ schema_version: 1, snapshot: tree.snapshot, validation: validateOzonCategoryPair(flattenOzonCategoryTree(tree), description_category_id, type_id) });
  });

  server.registerTool('auto_ozon.job.get', {
    title: 'Get product run',
    description: 'Return a Manifest V2 run without reading arbitrary paths.',
    inputSchema: z.object({ run_id: safeId() }),
    annotations: readOnlyAnnotations(),
  }, async ({ run_id }) => {
    const manifest = await new FileArtifactStore().readManifest(run_id);
    return toolResult(manifest ?? { error: { code: 'RUN_NOT_FOUND', message: 'Run does not exist.' } });
  });

  server.registerTool('auto_ozon.job.run_next', {
    title: 'Run or resume batch',
    description: 'Run the deterministic foreground workflow until completion or the next current-Agent decision.',
    inputSchema: z.object({ batch_id: safeId() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ batch_id }) => toolResult(await runBatchWorkflow({ batch_id })));

  server.registerTool('auto_ozon.decision.get_tasks', {
    title: 'Get Agent decision tasks',
    description: 'List paused product runs and the closed decision kind required from the current Agent.',
    inputSchema: z.object({ batch_id: safeId() }),
    annotations: readOnlyAnnotations(),
  }, async ({ batch_id }) => toolResult(await getBatchDecisionTasks(batch_id)));

  server.registerTool('auto_ozon.decision.submit', {
    title: 'Submit Agent decision',
    description: 'Save category, pricing, attribute, or image-review JSON into the fixed handoff slot for one offer.',
    inputSchema: z.object({
      batch_id: safeId(), offer_id: z.string().regex(/^[0-9]{5,32}$/u),
      kind: z.enum(['category', 'pricing', 'attributes', 'images']),
      envelope: z.object({
        schema_version: z.literal(1), task_id: z.string().min(1), run_id: safeId(),
        source_offer_id: z.string().regex(/^[0-9]{5,32}$/u),
        decision_type: z.enum(['category', 'attribute', 'content', 'image_review', 'package_estimate', 'market_score']),
        input_artifact_sha256: z.string().regex(/^[a-f0-9]{64}$/u), model: z.string().min(1),
        prompt_version: z.string().min(1), created_at: z.string().min(20),
        confidence: z.enum(['high', 'medium', 'low']),
        evidence_refs: z.array(z.object({ artifact_id: z.string().regex(/^[a-f0-9]{64}$/u), json_pointer: z.string().startsWith('/') })).min(1),
        assumptions: z.array(z.string()), output: z.unknown(),
      }),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => {
    return toolResult(await submitBatchAgentDecision(input));
  });

  server.registerTool('auto_ozon.review.bundle', {
    title: 'Get listing review bundle',
    description: 'Return manifest, pricing, attributes, images, draft, preflight and publish results for one run.',
    inputSchema: z.object({ run_id: safeId() }),
    annotations: readOnlyAnnotations(),
  }, async ({ run_id }) => toolResult(await getReviewBundle(run_id)));

  server.registerTool('auto_ozon.publish.execute', {
    title: 'Publish approved automatic store listing',
    description: 'High-risk fixed-endpoint publish. Store must be explicitly enabled and all preflight checks must pass.',
    inputSchema: z.object({ run_id: safeId(), store_id: safeId() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async (input) => toolResult(await runListingPublish(input)));

  server.registerTool('auto_ozon.publish.reconcile', {
    title: 'Resume publish reconciliation',
    description: 'Resume only the fixed listing-submit workflow for an existing run and store.',
    inputSchema: z.object({ run_id: safeId(), store_id: safeId() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (input) => toolResult(await runListingPublish(input)));

  server.registerTool('auto_ozon.publish.status', {
    title: 'Get publish status',
    description: 'Read the stored listing-submit result without calling Ozon.',
    inputSchema: z.object({ run_id: safeId() }),
    annotations: readOnlyAnnotations(),
  }, async ({ run_id }) => toolResult(await getListingPublishStatus(run_id)));

  server.registerTool('auto_ozon.batch.summary', {
    title: 'Get batch summary',
    description: 'Read batch counts, product runs, failures and paused work.',
    inputSchema: z.object({ batch_id: safeId() }),
    annotations: readOnlyAnnotations(),
  }, async ({ batch_id }) => toolResult(await getBatchWorkflowStatus(batch_id)));

  return server;
}

export async function runAutoOzonMcpServer(): Promise<void> {
  const server = createAutoOzonMcpServer();
  await server.connect(new StdioServerTransport());
}

export async function getBatchDecisionTasks(batchId: string): Promise<unknown> {
  const batch = await new FileBatchStore().readResult(batchId);
  const artifactStore = new FileArtifactStore();
  const tasks = [];
  for (const product of batch.product_runs.filter((entry) => entry.status === 'paused' && entry.run_id)) {
    const manifest = await artifactStore.readManifest(product.run_id!);
    const step = manifest?.current_step ?? null;
    const artifacts = manifest ? Object.values(manifest.steps).flatMap((entry) => entry.artifacts.map((artifact) => artifact.sha256)) : [];
    const inputHash = step ? manifest?.steps[step].input_hash ?? manifest?.steps[step].artifact?.sha256 ?? null : null;
    const categoryTask = step === 'category-decision'
      ? await artifactStore.read<CategoryDecisionAgentTaskV1>(product.run_id!, 'category-decision', 'category-agent-task-v1.json')
      : null;
    const pricingArtifact = step === 'cost-pricing'
      ? await artifactStore.read<{ agent_tasks?: unknown[] }>(product.run_id!, 'cost-pricing', 'cost-pricing-v1.json')
      : null;
    const attributeArtifact = step === 'attribute-mapping'
      ? await artifactStore.read<{ agent_tasks?: unknown[] }>(product.run_id!, 'attribute-mapping', 'attribute-mapping-v2.json')
      : null;
    const imageBundle = step === 'draft-generation'
      ? await artifactStore.read<{ status?: string; agent_tasks?: unknown[] }>(product.run_id!, 'draft-generation', 'image-bundle-v1.json')
      : null;
    const needsImageReview = imageBundle?.status === 'needs_review' && (imageBundle.agent_tasks?.length ?? 0) > 0;
    const agentTasks = categoryTask ? [categoryTask]
      : pricingArtifact?.agent_tasks?.length ? pricingArtifact.agent_tasks
        : attributeArtifact?.agent_tasks?.length ? attributeArtifact.agent_tasks
          : needsImageReview ? imageBundle?.agent_tasks ?? []
            : [];
    tasks.push({
      offer_id: product.offer_id,
      run_id: product.run_id,
      step,
      task_id: stableHash({ batch_id: batchId, offer_id: product.offer_id, run_id: product.run_id, step, input_hash: inputHash }),
      input_artifact_sha256: inputHash,
      evidence_artifact_ids: [...new Set(artifacts)],
      decision_kind: step === 'category-decision' ? 'category'
        : step === 'cost-pricing' ? 'pricing'
          : step === 'attribute-mapping' ? 'attributes'
            : step === 'draft-generation' && needsImageReview ? 'images'
              : 'review',
      agent_tasks: agentTasks,
      error: step ? manifest?.steps[step].error ?? null : null,
    });
  }
  return { schema_version: 1, batch_id: batchId, tasks };
}

async function validateDecisionEnvelope(
  batchId: string,
  offerId: string,
  kind: 'category' | 'pricing' | 'attributes' | 'images',
  envelope: {
    task_id: string; run_id: string; source_offer_id: string; decision_type: string;
    input_artifact_sha256: string; evidence_refs: Array<{ artifact_id: string; json_pointer: string }>;
  },
): Promise<{ ok: boolean; command: string; errors: Array<{ code: string; message: string; recoverable: boolean }>; warnings: []; nextActions: [] }> {
  const value = await getBatchDecisionTasks(batchId) as { tasks: Array<{
    offer_id: string; run_id: string; task_id: string; input_artifact_sha256: string | null;
    evidence_artifact_ids: string[]; decision_kind: string;
  }> };
  const task = value.tasks.find((entry) => entry.offer_id === offerId);
  const expectedType = kind === 'category' ? 'category'
    : kind === 'pricing' ? 'package_estimate'
      : kind === 'images' ? 'image_review'
        : 'attribute';
  const valid = task && task.task_id === envelope.task_id && task.run_id === envelope.run_id
    && task.decision_kind === kind
    && envelope.source_offer_id === offerId && envelope.decision_type === expectedType
    && task.input_artifact_sha256 === envelope.input_artifact_sha256
    && envelope.evidence_refs.every((reference) => task.evidence_artifact_ids.includes(reference.artifact_id));
  return valid
    ? { ok: true, command: 'auto_ozon.decision.submit.validate', errors: [], warnings: [], nextActions: [] }
    : { ok: false, command: 'auto_ozon.decision.submit.validate', errors: [{ code: 'AGENT_DECISION_ENVELOPE_MISMATCH', message: 'The decision is not bound to the current task, run, offer, input hash, or evidence artifacts.', recoverable: false }], warnings: [], nextActions: [] };
}

export async function submitBatchAgentDecision(input: {
  batch_id: string;
  offer_id: string;
  kind: 'category' | 'pricing' | 'attributes' | 'images';
  envelope: unknown;
}): Promise<CommandResult<{ saved: true }>> {
  if (!isAgentDecisionEnvelope(input.envelope)) {
    return decisionFailure('AGENT_DECISION_ENVELOPE_INVALID', 'A complete AgentDecisionEnvelopeV1 is required.');
  }
  const validated = await validateDecisionEnvelope(
    input.batch_id,
    input.offer_id,
    input.kind,
    input.envelope,
  );
  if (!validated.ok) return validated as CommandResult<never>;
  return submitBatchAgentInput({
    batch_id: input.batch_id,
    offer_id: input.offer_id,
    kind: input.kind,
    value: input.envelope.output,
  });
}

function isAgentDecisionEnvelope(value: unknown): value is AgentDecisionEnvelopeV1<unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const envelope = value as Partial<AgentDecisionEnvelopeV1<unknown>>;
  return envelope.schema_version === 1
    && typeof envelope.task_id === 'string' && envelope.task_id.length > 0
    && typeof envelope.run_id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(envelope.run_id)
    && typeof envelope.source_offer_id === 'string' && /^[0-9]{5,32}$/u.test(envelope.source_offer_id)
    && ['category', 'attribute', 'content', 'image_review', 'package_estimate', 'market_score'].includes(String(envelope.decision_type))
    && typeof envelope.input_artifact_sha256 === 'string' && /^[a-f0-9]{64}$/u.test(envelope.input_artifact_sha256)
    && typeof envelope.model === 'string' && envelope.model.length > 0
    && typeof envelope.prompt_version === 'string' && envelope.prompt_version.length > 0
    && typeof envelope.created_at === 'string' && Number.isFinite(Date.parse(envelope.created_at))
    && ['high', 'medium', 'low'].includes(String(envelope.confidence))
    && Array.isArray(envelope.evidence_refs) && envelope.evidence_refs.length > 0
    && envelope.evidence_refs.every((reference) => Boolean(reference)
      && /^[a-f0-9]{64}$/u.test(String(reference.artifact_id))
      && typeof reference.json_pointer === 'string' && reference.json_pointer.startsWith('/'))
    && Array.isArray(envelope.assumptions)
    && Object.hasOwn(envelope, 'output');
}

function decisionFailure(code: string, message: string): CommandResult<never> {
  return { ok: false, command: 'auto_ozon.decision.submit', warnings: [], errors: [{ code, message, recoverable: false }], nextActions: [] };
}

export async function getReviewBundle(runId: string): Promise<unknown> {
  const store = new FileArtifactStore();
  const manifest = await store.readManifest(runId);
  if (!manifest) return { error: { code: 'RUN_NOT_FOUND', message: 'Run does not exist.' } };
  const read = <T>(step: WorkflowStepName, name: string) => store.read<T>(runId, step, name);
  const [pricing, attributes, content, images, draft, preflight, publish] = await Promise.all([
    read('cost-pricing', 'cost-pricing-v1.json'),
    read('attribute-mapping', 'attribute-mapping-v2.json'),
    read('attribute-mapping', 'content-bundle-v1.json'),
    read('draft-generation', 'image-bundle-v1.json'),
    read('draft-generation', 'listing-draft-v2.json'),
    read('listing-submit', 'preflight-report-v1.json'),
    read('listing-submit', 'ozon-publish-result-v1.json'),
  ]);
  return { schema_version: 1, run_id: runId, manifest, pricing, attributes, content, images, draft, preflight, publish };
}

function toolResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function readOnlyAnnotations() {
  return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
}

function safeId() { return z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u); }
function profileName() { return z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u); }
function stableHash(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
}
