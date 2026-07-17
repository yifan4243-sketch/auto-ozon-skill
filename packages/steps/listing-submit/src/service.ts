import { createHash } from 'node:crypto';
import type { CommandResult, ListingDraftItemV1, ListingDraftV1, OutboxRecordV1, OzonPublishResultV1, PreflightReportV1, PublishIntentV1, SellerImportTransportV1, StorePublishProfileV1 } from '@auto-ozon/contracts';
import { assertWorkflowActive, type WorkflowContext } from '@auto-ozon/artifact-store';
import type { PublishReliabilityStore } from '@auto-ozon/job-store';

export interface RunListingSubmitInput {
  draft: ListingDraftV1; profile: StorePublishProfileV1; transport: SellerImportTransportV1;
  previous?: OzonPublishResultV1; run_id?: string; preflight?: PreflightReportV1;
  reliability_store?: PublishReliabilityStore;
}

export async function runListingSubmit(input: RunListingSubmitInput, context?: WorkflowContext): Promise<CommandResult<OzonPublishResultV1>> {
  try {
    if (context) { assertWorkflowActive(context); await context.artifact_store.updateStep(context.run_id, 'listing-submit', { status: 'running' }); }
    const result = await submit(input);
    if (context) { const output = await context.artifact_store.write(context.run_id, 'listing-submit', 'ozon-publish-result-v1.json', result); await context.artifact_store.updateStep(context.run_id, 'listing-submit', { status: result.status === 'completed' ? 'succeeded' : result.status === 'partial_failed' || result.status === 'polling_timeout' ? 'needs_review' : 'blocked', output }); }
    return { ok: result.status === 'completed' || result.status === 'partial_failed' || result.status === 'polling_timeout', command: 'listing.submit', data: result, warnings: result.warnings.map((message) => ({ code: 'OZON_PUBLISH_WARNING', message })), errors: result.errors.map((message) => ({ code: 'OZON_PUBLISH_FAILED', message, recoverable: true })), nextActions: result.status === 'polling_timeout' ? ['Run workflow listing resume with the same run and store ID.'] : [] };
  } catch (error) { if (context) await context.artifact_store.updateStep(context.run_id, 'listing-submit', { status: 'failed', error_code: 'LISTING_SUBMIT_FAILED' }); return { ok: false, command: 'listing.submit', warnings: [], errors: [{ code: 'LISTING_SUBMIT_FAILED', message: error instanceof Error ? redact(error.message) : String(error), recoverable: true }], nextActions: [] }; }
}

async function submit(input: RunListingSubmitInput): Promise<OzonPublishResultV1> {
  const hashes = new Map(input.draft.items.map((item) => [item.offer_id, hash(item)]));
  const result: OzonPublishResultV1 = { schema_version: 1, store_id: input.profile.store_id, source_offer_id: input.draft.source_offer_id, draft_sha256: hash(input.draft.items), status: 'blocked', task_ids: [], task_items: {}, submitted_at: null, completed_at: null, sku_results: input.draft.items.map((item) => ({ offer_id: item.offer_id, request_hash: hashes.get(item.offer_id)!, status: 'pending', product_id: null, errors: [], retry_count: 0 })), warnings: [], errors: [] };
  if (!input.profile.publishing.enabled) { result.errors.push('PUBLISHING_DISABLED'); return result; }
  if (input.preflight && input.preflight.status !== 'passed') { result.errors.push('PREFLIGHT_BLOCKED'); return result; }
  if (input.draft.status !== 'draft_complete' || input.draft.items.length === 0) { result.errors.push('DRAFT_NOT_PUBLISH_READY'); return result; }
  if (input.draft.items.some((item) => item.currency_code !== 'CNY')) { result.errors.push('DRAFT_CURRENCY_UNSUPPORTED'); return result; }
  const previousMatchesDraft = input.previous?.store_id === result.store_id && input.previous.draft_sha256 === result.draft_sha256;
  if (previousMatchesDraft && input.previous) {
    result.task_ids = [...input.previous.task_ids]; result.task_items = { ...(input.previous.task_items ?? {}) };
    result.submitted_at = input.previous.submitted_at;
    for (const prior of input.previous.sku_results) {
      const current = result.sku_results.find((item) => item.offer_id === prior.offer_id);
      if (!current || prior.request_hash !== current.request_hash) continue;
      Object.assign(current, prior);
      if (prior.status === 'imported') current.status = 'skipped';
    }
  }
  const deadline = Date.now() + input.profile.polling.timeout_ms;
  const intentIds = new Map<string, string>();
  if (input.reliability_store) {
    const reconciled = await reconcileAndPrepareIntents(input, result, intentIds, deadline);
    if (!reconciled) {
      result.warnings.push('PUBLISH_RECONCILIATION_REQUIRED');
      return timeout(result);
    }
  }
  // A resume polls the outstanding Ozon task first. It never submits the same
  // items again merely because the previous foreground poll timed out.
  if (previousMatchesDraft && input.previous?.status === 'polling_timeout') {
    for (const taskId of result.task_ids) {
      const offerIds = result.task_items[taskId] ?? result.sku_results.filter((row) => row.status === 'pending').map((row) => row.offer_id);
      if (!offerIds.some((offerId) => row(result, offerId)?.status === 'pending')) continue;
      const complete = await pollTask(input.transport, taskId, offerIds, result, deadline, input.profile.polling.interval_ms);
      if (!complete) return timeout(result);
    }
  }
  while (true) {
    const pending = input.draft.items.filter((item) => row(result, item.offer_id)?.status === 'pending');
    if (pending.length === 0) {
      const retryable = result.sku_results.filter((item) => item.status === 'failed' && item.retry_count < input.profile.polling.max_recoverable_retries && isRecoverable(item.errors, item.recoverable));
      if (retryable.length === 0) break;
      for (const item of retryable) { item.retry_count += 1; item.status = 'pending'; }
      continue;
    }
    const submission = await input.transport.submit(pending);
    if (input.reliability_store) {
      const ids = pending.map((item) => intentIds.get(item.offer_id)).filter((value): value is string => Boolean(value));
      await input.reliability_store.markSubmitted(ids, submission.task_id);
    }
    const submittedOfferIds = pending.map((item) => item.offer_id);
    result.task_ids.push(submission.task_id); result.task_items[submission.task_id] = submittedOfferIds; result.submitted_at ??= new Date().toISOString();
    const complete = await pollTask(input.transport, submission.task_id, submittedOfferIds, result, deadline, input.profile.polling.interval_ms);
    if (!complete) return timeout(result);
  }
  const imported = result.sku_results.filter((item) => item.status === 'imported' || item.status === 'skipped').map((item) => item.offer_id);
  if (imported.length) { const products = await input.transport.getProductsByOfferIds(imported); for (const product of products) { const row = result.sku_results.find((item) => item.offer_id === product.offer_id); if (row) row.product_id = product.product_id; } }
  if (input.reliability_store) {
    for (const current of result.sku_results) {
      const intentId = intentIds.get(current.offer_id);
      if (!intentId) continue;
      if (current.status === 'imported' || current.status === 'skipped') await input.reliability_store.markReconciled(intentId, 'succeeded', current.product_id);
      else if (current.status === 'failed') await input.reliability_store.markReconciled(intentId, 'failed', null);
    }
  }
  result.completed_at = new Date().toISOString(); result.status = result.sku_results.some((item) => item.status === 'failed') ? 'partial_failed' : 'completed'; return result;
}

async function reconcileAndPrepareIntents(
  input: RunListingSubmitInput,
  result: OzonPublishResultV1,
  intentIds: Map<string, string>,
  deadline: number,
): Promise<boolean> {
  const store = input.reliability_store!;
  const runId = input.run_id ?? 'direct-call';
  const items = input.draft.items;
  const uncertain = await store.listUncertainIntents(input.profile.store_id, items.map((item) => item.offer_id));
  const remoteProducts = uncertain.length ? await input.transport.getProductsByOfferIds([...new Set(uncertain.map((item) => item.offer_id))]) : [];
  const remoteByOffer = new Map(remoteProducts.map((item) => [item.offer_id, item.product_id]));
  for (const prior of uncertain) {
    const productId = remoteByOffer.get(prior.offer_id);
    if (productId !== undefined) {
      await store.markReconciled(prior.intent_id, 'succeeded', productId);
      const current = row(result, prior.offer_id);
      if (current) { current.status = 'skipped'; current.product_id = productId; }
    }
  }
  const taskGroups = new Map<string, string[]>();
  for (const prior of uncertain) {
    if (remoteByOffer.has(prior.offer_id) || !prior.task_id) continue;
    const group = taskGroups.get(prior.task_id) ?? [];
    group.push(prior.offer_id); taskGroups.set(prior.task_id, group);
  }
  for (const [taskId, offerIds] of taskGroups) {
    const completed = await pollTask(input.transport, taskId, offerIds, result, deadline, input.profile.polling.interval_ms);
    if (!completed) return false;
  }
  if (uncertain.some((prior) => !remoteByOffer.has(prior.offer_id) && !prior.task_id)) {
    // The process may have crashed after Ozon accepted the request but before
    // task_id was committed. A missing product in an immediate read is not
    // proof that Ozon did not create it, so automatic resubmission is forbidden.
    return false;
  }
  const records: Array<{ intent: PublishIntentV1; outbox: OutboxRecordV1 }> = [];
  for (const item of items) {
    const itemHash = hash(item);
    const existing = await store.getIntent(input.profile.store_id, item.offer_id, itemHash);
    if (existing) {
      intentIds.set(item.offer_id, existing.intent_id);
      if (existing.status === 'succeeded') {
        const current = row(result, item.offer_id);
        if (current) { current.status = 'skipped'; current.product_id = existing.product_id; }
      }
      continue;
    }
    const intentId = hash({ store_id: input.profile.store_id, offer_id: item.offer_id, item_hash: itemHash }).slice(0, 40);
    const now = new Date().toISOString();
    const intent: PublishIntentV1 = { schema_version: 1, intent_id: intentId, run_id: runId, store_id: input.profile.store_id,
      offer_id: item.offer_id, item_hash: itemHash, status: 'prepared', task_id: null, product_id: null, created_at: now, updated_at: now };
    const outbox: OutboxRecordV1 = { schema_version: 1, outbox_id: `outbox-${intentId}`, intent_id: intentId,
      status: 'pending', attempts: 0, last_error_code: null, created_at: now, updated_at: now };
    records.push({ intent, outbox }); intentIds.set(item.offer_id, intentId);
  }
  if (records.length) await store.prepareIntents(records);
  return true;
}
async function pollTask(transport: SellerImportTransportV1, taskId: string, offerIds: string[], result: OzonPublishResultV1, deadline: number, interval: number): Promise<boolean> {
  let info;
  do { info = await transport.getImportInfo(taskId); if (!info.complete && Date.now() < deadline) await delay(interval); } while (!info.complete && Date.now() < deadline);
  if (!info.complete) return false;
  const expected = new Set(offerIds); const received = new Set(info.items.map((item) => item.offer_id));
  for (const remote of info.items) { if (!expected.has(remote.offer_id)) continue; const current = row(result, remote.offer_id); if (!current) continue; current.status = remote.status === 'imported' ? 'imported' : remote.status === 'pending' ? 'pending' : 'failed'; current.errors = remote.errors ?? []; current.recoverable = remote.recoverable; }
  for (const offerId of offerIds) { if (!received.has(offerId)) { const current = row(result, offerId); if (current) { current.status = 'failed'; current.errors = ['IMPORT_RESULT_MISSING']; } } }
  return true;
}
function timeout(result: OzonPublishResultV1): OzonPublishResultV1 { result.status = 'polling_timeout'; if (!result.warnings.includes('POLLING_TIMEOUT')) result.warnings.push('POLLING_TIMEOUT'); return result; }
function row(result: OzonPublishResultV1, offerId: string) { return result.sku_results.find((item) => item.offer_id === offerId); }
function isRecoverable(errors: string[], explicit?: boolean): boolean { return explicit ?? !errors.some((value) => /(?:attribute|validation|required|category|image|invalid|auth|permission)/iu.test(value)); }
function stable(value: unknown): string { if (value === null || typeof value !== 'object') return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`; const object = value as Record<string, unknown>; return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stable(object[key])}`).join(',')}}`; }
function hash(value: unknown): string { return createHash('sha256').update(stable(value)).digest('hex'); }
function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
function redact(value: string): string { return value.replace(/(Api-Key|Authorization)\s*[:=]\s*[^\s,}]+/giu, '$1=[REDACTED]'); }
