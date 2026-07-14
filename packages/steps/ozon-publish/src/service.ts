import type { OzonSellerWriteTransport, OzonImportStatusItem } from '@auto-ozon/adapters-ozon';
import type {
  CommandResult, ListingPayloadV1, OzonPublishResultV1, OzonPublishSkuResultV1, StorePublishProfileV1,
} from '@auto-ozon/contracts';
import type { WorkflowContext } from '@auto-ozon/artifact-store';

export interface RunOzonPublishInput {
  payload: ListingPayloadV1;
  profile: StorePublishProfileV1;
  transport: OzonSellerWriteTransport;
  previous_result?: OzonPublishResultV1;
  signal?: AbortSignal;
}

export async function runOzonPublish(
  input: RunOzonPublishInput,
  context?: WorkflowContext,
): Promise<CommandResult<OzonPublishResultV1>> {
  const submittedAt = new Date().toISOString();
  try {
    if (!input.profile.publishing.enabled) throw new Error('Store publishing is disabled.');
    if (context) await context.artifact_store.updateStep(context.run_id, 'ozon-publish', { status: 'running', step_version: '1.0.0' });
    const previous = input.previous_result?.request_sha256 === input.payload.request_sha256
      ? new Map(input.previous_result.items.filter((item) => item.status === 'imported').map((item) => [item.offer_id, item]))
      : new Map<string, OzonPublishSkuResultV1>();
    const byOffer = new Map(input.payload.request.items.map((item) => [item.offer_id, item]));
    const sourceByOffer = new Map(Object.entries(input.payload.sku_offer_ids).map(([source, offer]) => [offer, source]));
    const final = new Map<string, OzonPublishSkuResultV1>(previous);
    const taskIds: number[] = [];
    let pendingOffers = [...byOffer.keys()].filter((offerId) => !final.has(offerId));

    for (let retry = 0; pendingOffers.length > 0 && retry <= 2; retry += 1) {
      const items = pendingOffers.map((offerId) => byOffer.get(offerId)!);
      const taskId = await input.transport.importProducts(items, input.signal);
      taskIds.push(taskId);
      const statuses = await poll(input.transport, taskId, input.profile, input.signal);
      const retryable: string[] = [];
      for (const offerId of pendingOffers) {
        const status = statuses.find((item) => item.offer_id === offerId) ?? {
          offer_id: offerId, product_id: 0, status: 'failed' as const,
          errors: [{ code: 'MISSING_IMPORT_STATUS', message: 'Ozon did not return a status for this offer.' }],
        };
        const result = toResult(sourceByOffer.get(offerId)!, status, retry);
        final.set(offerId, result);
        if (result.status === 'failed' && retry < 2 && result.errors.some((error) => isRecoverable(error.code))) retryable.push(offerId);
      }
      pendingOffers = retryable;
    }

    const imported = [...final.values()].filter((item) => item.status === 'imported');
    if (imported.length > 0) {
      const identities = await input.transport.getProductIdentities(imported.map((item) => item.offer_id), input.signal);
      for (const identity of identities) {
        const item = final.get(identity.offer_id);
        if (!item) continue;
        item.product_id = identity.product_id;
        item.ozon_sku = identity.sku;
        item.product_url = `https://www.ozon.ru/context/detail/id/${identity.sku}/`;
      }
    }
    const values = [...final.values()];
    const successCount = values.filter((item) => item.status === 'imported' || item.status === 'skipped').length;
    const result: OzonPublishResultV1 = {
      schema_version: 1, run_id: input.payload.run_id, request_sha256: input.payload.request_sha256, task_ids: taskIds,
      status: successCount === values.length ? 'succeeded' : successCount > 0 ? 'partial' : 'failed',
      submitted_at: submittedAt, completed_at: new Date().toISOString(), items: values,
    };
    if (context) {
      const output = await context.artifact_store.write(context.run_id, 'ozon-publish', 'ozon-publish-result-v1.json', result);
      await context.artifact_store.updateStep(context.run_id, 'ozon-publish', {
        status: result.status === 'succeeded' ? 'succeeded' : 'failed', output, step_version: '1.0.0',
        error: result.status === 'succeeded' ? null : { code: 'OZON_PUBLISH_INCOMPLETE', message: 'One or more SKUs failed to publish.', recoverable: result.status === 'partial' },
      });
    }
    return {
      ok: result.status === 'succeeded', command: 'ozon.publish', data: result, warnings: [],
      errors: values.filter((item) => item.status === 'failed' || item.status === 'timed_out').flatMap((item) => item.errors.map((error) => ({ code: error.code, message: error.message, detail: { offer_id: item.offer_id, ...error }, recoverable: isRecoverable(error.code) }))),
      nextActions: result.status === 'partial' ? ['Inspect failed SKU errors; successful SKUs were preserved.'] : [],
    };
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : String(error));
    if (context) await context.artifact_store.updateStep(context.run_id, 'ozon-publish', { status: 'failed', error: { code: 'OZON_PUBLISH_FAILED', message, recoverable: true } });
    return { ok: false, command: 'ozon.publish', warnings: [], errors: [{ code: 'OZON_PUBLISH_FAILED', message, recoverable: true }], nextActions: [] };
  }
}

async function poll(transport: OzonSellerWriteTransport, taskId: number, profile: StorePublishProfileV1, signal?: AbortSignal): Promise<OzonImportStatusItem[]> {
  const deadline = Date.now() + profile.polling.timeout_ms;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw signal.reason ?? new Error('Publishing aborted.');
    const items = await transport.getImportInfo(taskId, signal);
    if (items.length > 0 && items.every((item) => item.status !== 'pending')) return items;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, profile.polling.interval_ms);
      signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    });
  }
  throw new Error(`Ozon import task ${taskId} timed out.`);
}

function toResult(sourceSkuId: string, status: OzonImportStatusItem, retry: number): OzonPublishSkuResultV1 {
  return { source_sku_id: sourceSkuId, offer_id: status.offer_id, product_id: status.product_id || null, ozon_sku: null,
    product_url: null, status: status.status, errors: status.errors, retry_count: retry };
}
function isRecoverable(code: string): boolean { return /(?:TIMEOUT|TEMPORARY|INTERNAL|UNAVAILABLE|RATE_LIMIT|MISSING_IMPORT_STATUS)/i.test(code); }
function redact(value: string): string { return value.replace(/(Api-Key|Client-Id|token|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]'); }
