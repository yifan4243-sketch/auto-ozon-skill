import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { StoreProfileV2, WorkflowStepName } from '@auto-ozon/contracts';
import { FileArtifactStore, resolveRepoRoot } from '@auto-ozon/artifact-store';
import { FileBatchStore } from '@auto-ozon/batch-orchestrator';
import { validateStoreProfileV2 } from '@auto-ozon/config';
import { runListingPreparation, setStorePublishingConsent } from '@auto-ozon/workflows';
import { getReviewBundle, submitBatchAgentDecision } from './mcp-server.js';

export interface ReviewConsoleOptionsV1 {
  host?: '127.0.0.1';
  port?: number;
  repo_root?: string;
  mode?: 'local';
  /** Optional durable state read model. This does not provide shared artifacts,
   * public hosting, OIDC, RBAC, or multi-node team deployment. */
  state_reader?: ReviewConsoleStateReaderV1;
}

export interface ReviewConsoleStateSnapshotV1 {
  batches: unknown[];
  runs: unknown[];
}

export interface ReviewConsoleStateReaderV1 {
  readOverview(): Promise<ReviewConsoleStateSnapshotV1>;
  readRun(runId: string): Promise<unknown | null>;
}

export interface RunningReviewConsoleV1 {
  url: string;
  close(): Promise<void>;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SAFE_OFFER_ID = /^[0-9]{5,32}$/u;
const RERUNNABLE_STEPS = new Set<WorkflowStepName>([
  'canonicalize-product', 'cost-pricing', 'category-attributes', 'draft-generation',
]);

export async function startReviewConsole(
  options: ReviewConsoleOptionsV1 = {},
): Promise<RunningReviewConsoleV1> {
  const root = path.resolve(options.repo_root ?? resolveRepoRoot());
  const host = options.host ?? '127.0.0.1';
  const requestedMode = (options as { mode?: unknown }).mode ?? 'local';
  if (host !== '127.0.0.1') throw new Error('REVIEW_CONSOLE_LOCALHOST_ONLY');
  if (requestedMode !== 'local') throw new Error('REVIEW_CONSOLE_TEAM_MODE_UNSUPPORTED');
  const session = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(32).toString('base64url');
  const cspNonce = crypto.randomBytes(24).toString('base64url');
  let origin = '';

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', origin || `http://${host}`);
      if (!authorized(request, session)) {
        sendJson(response, 401, { error: { code: 'UNAUTHORIZED', message: 'Authentication required.' } });
        return;
      }
      if (request.method !== 'GET' && !validMutationRequest(request, origin, csrf)) {
        sendJson(response, 403, { error: { code: 'CSRF_REJECTED', message: 'Same-origin CSRF validation failed.' } });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/') {
        response.setHeader('Set-Cookie', `auto_ozon_review=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800; Priority=High`);
        sendHtml(response, renderShell(csrf, cspNonce), cspNonce);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/overview') {
        sendJson(response, 200, await readOverview(root, options.state_reader));
        return;
      }
      const runMatch = url.pathname.match(/^\/api\/runs\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/u);
      if (request.method === 'GET' && runMatch) {
        const durable = options.state_reader ? await options.state_reader.readRun(runMatch[1]!) : null;
        const artifacts = await getReviewBundle(runMatch[1]!).catch(() => null);
        if (!durable && !artifacts) throw httpError(404, 'RUN_NOT_FOUND');
        sendJson(response, 200, { durable_state: durable, artifacts });
        return;
      }
      const storeMatch = url.pathname.match(/^\/api\/stores\/([A-Za-z0-9_-]{1,64})\/publishing$/u);
      if (request.method === 'POST' && storeMatch) {
        const body = await readJsonBody(request);
        if (typeof body.enabled !== 'boolean') throw httpError(400, 'ENABLED_BOOLEAN_REQUIRED');
        const changed = await setStorePublishingConsent({
          store_id: storeMatch[1]!,
          enabled: body.enabled,
          actor: 'local-review-console',
          source: 'local_review_console',
          repo_root: root,
        });
        if (!changed.ok) throw httpError(409, changed.errors[0]?.code ?? 'PUBLISHING_CONSENT_FAILED');
        sendJson(response, 200, changed);
        return;
      }
      const decisionMatch = url.pathname.match(/^\/api\/batches\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})\/decisions$/u);
      if (request.method === 'POST' && decisionMatch) {
        const body = await readJsonBody(request);
        if (!SAFE_OFFER_ID.test(String(body.offer_id ?? ''))) throw httpError(400, 'OFFER_ID_INVALID');
        if (!['category', 'pricing', 'attributes', 'images'].includes(String(body.kind))) throw httpError(400, 'DECISION_KIND_INVALID');
        const result = await submitBatchAgentDecision({
          batch_id: decisionMatch[1]!, offer_id: String(body.offer_id),
          kind: body.kind as 'category' | 'pricing' | 'attributes' | 'images', envelope: body.envelope,
        });
        sendJson(response, result.ok ? 200 : 422, result);
        return;
      }
      const rerunMatch = url.pathname.match(/^\/api\/runs\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})\/rerun$/u);
      if (request.method === 'POST' && rerunMatch) {
        const body = await readJsonBody(request);
        const step = String(body.step ?? '') as WorkflowStepName;
        if (!RERUNNABLE_STEPS.has(step)) throw httpError(400, 'STEP_NOT_SAFE_FOR_CONSOLE_RERUN');
        const result = await runListingPreparation({
          run_id: rerunMatch[1]!, start_from: step, stop_after: step, force_steps: [step], stop_on_review: true,
        });
        sendJson(response, result.ok ? 200 : 422, result);
        return;
      }
      sendJson(response, 404, { error: { code: 'NOT_FOUND', message: 'Route not found.' } });
    } catch (error) {
      const status = isHttpError(error) ? error.status : 500;
      sendJson(response, status, { error: { code: errorCode(error), message: safeMessage(error) } });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => resolve());
  });
  const address = server.address() as AddressInfo;
  origin = `http://${host}:${address.port}`;
  return {
    url: origin,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function readOverview(root: string, stateReader?: ReviewConsoleStateReaderV1): Promise<unknown> {
  const stores = await readStores(root).catch(() => []);
  if (stateReader) {
    const durable = await stateReader.readOverview();
    return {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      stores: summarizeStores(stores),
      batches: durable.batches,
      runs: durable.runs,
    };
  }
  const batchStore = new FileBatchStore(path.join(root, 'data', 'batches'));
  const artifactStore = new FileArtifactStore({ repoRoot: root });
  const batches = [];
  for (const id of await safeDirectories(path.join(root, 'data', 'batches'))) {
    if (!SAFE_ID.test(id)) continue;
    const value = await batchStore.readResult(id).catch(() => null);
    if (value) batches.push(value);
  }
  const runs = [];
  for (const id of await safeDirectories(path.join(root, 'data', 'runs'))) {
    if (!SAFE_ID.test(id)) continue;
    const manifest = await artifactStore.readManifest(id).catch(() => null);
    if (!manifest) continue;
    runs.push({
      run_id: id, status: manifest.status, current_step: manifest.current_step,
      updated_at: manifest.updated_at,
      steps: Object.entries(manifest.steps).map(([name, step]) => ({
        name, status: step.status, attempt: step.current_attempt,
        elapsed_ms: elapsed(step.started_at, step.completed_at), error: step.error,
      })),
    });
  }
  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    stores: summarizeStores(stores),
    batches: batches.sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
    runs: runs.sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
  };
}

function summarizeStores(stores: StoreProfileV2[]): unknown[] {
  return stores.map((store) => ({
    store_id: store.store_id, store_name: store.store_name, currency_code: store.currency_code,
    publishing_enabled: store.publishing.enabled, daily_listing_limit: store.publishing.daily_listing_limit,
  }));
}

async function readStores(root: string): Promise<StoreProfileV2[]> {
  const file = path.join(root, 'data', 'config', 'ozon-stores.local.json');
  const value = JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
  if (!Array.isArray(value)) throw new Error('STORE_PROFILE_LIST_REQUIRED');
  return value.map((entry) => validateStoreProfileV2(entry));
}

async function safeDirectories(root: string): Promise<string[]> {
  try {
    return (await fs.readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function authorized(request: IncomingMessage, session: string): boolean {
  if (request.method === 'GET' && request.url === '/') return true;
  return parseCookies(request.headers.cookie).auto_ozon_review === session;
}

function validMutationRequest(request: IncomingMessage, origin: string, csrf: string): boolean {
  return request.headers.origin === origin && request.headers['x-csrf-token'] === csrf;
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw httpError(413, 'REQUEST_BODY_TOO_LARGE');
    chunks.push(buffer);
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw httpError(400, 'INVALID_JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw httpError(400, 'JSON_OBJECT_REQUIRED');
  return value as Record<string, unknown>;
}

function renderShell(csrf: string, nonce: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="csrf-token" content="${csrf}"><title>Auto Ozon 审核台</title><style nonce="${nonce}">
  :root{color-scheme:dark;--bg:#0a0d12;--panel:#111722;--line:#263142;--text:#edf3fa;--muted:#93a4b8;--ok:#35d07f;--warn:#ffbf47;--bad:#ff6577;--brand:#5b8cff}*{box-sizing:border-box}body{margin:0;font:14px/1.5 ui-sans-serif,system-ui;background:radial-gradient(circle at 80% 0,#172441 0,transparent 35%),var(--bg);color:var(--text)}header{padding:32px max(24px,5vw) 20px;border-bottom:1px solid var(--line)}h1{margin:0;font-size:28px}header p{color:var(--muted);margin:6px 0 0}main{padding:24px max(24px,5vw) 60px;display:grid;gap:20px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:14px}.card,.panel{background:color-mix(in srgb,var(--panel) 92%,transparent);border:1px solid var(--line);border-radius:16px;padding:18px;box-shadow:0 14px 40px #0004}.metric{font-size:30px;font-weight:750}.muted{color:var(--muted)}h2{margin:0 0 14px;font-size:18px}.row{display:flex;align-items:center;gap:10px;justify-content:space-between;padding:12px 0;border-top:1px solid var(--line)}.row:first-of-type{border-top:0}.pill{padding:3px 9px;border-radius:999px;background:#263142;color:var(--muted)}button{border:0;border-radius:9px;padding:8px 12px;background:var(--brand);color:white;font-weight:650;cursor:pointer}button.secondary{background:#263142}button.danger{background:#7e2f3d}.grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}.actions{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px}input,select,textarea{width:100%;border:1px solid var(--line);border-radius:9px;background:#070a0f;color:var(--text);padding:10px;margin:5px 0 10px}textarea{min-height:150px;font-family:ui-monospace,monospace}pre{white-space:pre-wrap;max-height:520px;overflow:auto;background:#070a0f;padding:14px;border-radius:10px;color:#bed1e8}@media(max-width:900px){.grid{grid-template-columns:1fr}}
  </style></head><body><header><h1>Auto Ozon 审核台</h1><p>仅限本机 · 凭据永不回显 · 工件与发布链路可追溯</p></header><main><section class="cards" id="metrics"></section><section class="grid"><div class="panel"><h2>店铺</h2><div id="stores"></div></div><div class="panel"><h2>批次</h2><div id="batches"></div></div></section><section class="panel"><h2>商品 Run</h2><div id="runs"></div></section><section class="panel" id="detailPanel" hidden><h2>审核详情</h2><div class="actions"><select id="rerunStep"><option value="canonicalize-product">标准化</option><option value="cost-pricing">成本定价</option><option value="category-attributes">类目属性</option><option value="draft-generation">图片与草稿</option></select><button id="rerunButton">重跑所选步骤</button></div><pre id="detail"></pre></section><section class="panel"><h2>提交 Agent 修复值</h2><div class="grid"><div><label>批次 ID<input id="decisionBatch"></label><label>1688 Offer ID<input id="decisionOffer"></label><label>决策类型<select id="decisionKind"><option value="category">类目</option><option value="pricing">包装估算</option><option value="attributes">属性与俄语内容</option><option value="images">图片文字/水印审核</option></select></label></div><div><label>AgentDecisionEnvelopeV1 JSON<textarea id="decisionValue" spellcheck="false">{}</textarea></label><button id="submitDecisionButton">验证并保存</button></div></div><pre id="actionResult" hidden></pre></section></main><script nonce="${nonce}">
  const csrf=document.querySelector('meta[name=csrf-token]').content;const e=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  async function api(url,options={}){const r=await fetch(url,{...options,headers:{'content-type':'application/json','x-csrf-token':csrf,...options.headers}});const j=await r.json();if(!r.ok)throw new Error(j.error?.message||r.statusText);return j}
  async function load(){const d=await api('/api/overview');metrics.innerHTML=[['店铺',d.stores.length],['批次',d.batches.length],['商品 Run',d.runs.length],['异常',d.runs.filter(r=>['blocked','failed','needs_review','interrupted'].includes(r.status)).length]].map(x=>'<div class=card><div class=muted>'+x[0]+'</div><div class=metric>'+x[1]+'</div></div>').join('');stores.innerHTML=d.stores.map(s=>'<div class=row><div><b>'+e(s.store_name)+'</b><div class=muted>'+e(s.store_id)+' · '+e(s.currency_code)+'</div></div><button class="publish-toggle '+(s.publishing_enabled?'danger':'')+'" data-store="'+e(s.store_id)+'" data-enabled="'+String(!s.publishing_enabled)+'">'+(s.publishing_enabled?'禁用发布':'启用发布')+'</button></div>').join('')||'<p class=muted>尚未配置店铺</p>';batches.innerHTML=d.batches.map(b=>'<div class=row><div><b>'+e(b.batch_id)+'</b><div class=muted>'+e(b.status)+' · 成功 '+b.succeeded_count+'/'+b.requested_listing_count+'</div></div><span class=pill>'+b.candidate_count+' 候选</span></div>').join('')||'<p class=muted>暂无批次</p>';runs.innerHTML=d.runs.map(r=>'<div class=row><div><b>'+e(r.run_id)+'</b><div class=muted>'+e(r.current_step||'未开始')+' · '+e(r.status)+'</div></div><button class="secondary run-detail" data-run="'+e(r.run_id)+'">查看</button></div>').join('')||'<p class=muted>暂无 Run</p>'}
  async function toggleStore(id,enabled){if(!confirm((enabled?'启用':'禁用')+'该店铺自动发布？'))return;await api('/api/stores/'+encodeURIComponent(id)+'/publishing',{method:'POST',body:JSON.stringify({enabled})});await load()}
  let currentRun='';async function showRun(id){currentRun=id;const d=await api('/api/runs/'+encodeURIComponent(id));detail.textContent=JSON.stringify(d,null,2);detailPanel.hidden=false;detailPanel.scrollIntoView({behavior:'smooth'})}
  async function rerunCurrent(){if(!currentRun)return;const d=await api('/api/runs/'+encodeURIComponent(currentRun)+'/rerun',{method:'POST',body:JSON.stringify({step:rerunStep.value})});actionResult.hidden=false;actionResult.textContent=JSON.stringify(d,null,2);await showRun(currentRun);await load()}
  async function submitDecision(){let envelope;try{envelope=JSON.parse(decisionValue.value)}catch{alert('决策 JSON 无效');return}const d=await api('/api/batches/'+encodeURIComponent(decisionBatch.value)+'/decisions',{method:'POST',body:JSON.stringify({offer_id:decisionOffer.value,kind:decisionKind.value,envelope})});actionResult.hidden=false;actionResult.textContent=JSON.stringify(d,null,2);await load()}
  stores.addEventListener('click',event=>{const button=event.target.closest('.publish-toggle');if(button)toggleStore(button.dataset.store,button.dataset.enabled==='true')});
  runs.addEventListener('click',event=>{const button=event.target.closest('.run-detail');if(button)showRun(button.dataset.run)});
  rerunButton.addEventListener('click',rerunCurrent);submitDecisionButton.addEventListener('click',submitDecision);
  load().catch(err=>document.body.insertAdjacentHTML('beforeend','<pre>'+e(err.message)+'</pre>'));
  </script></body></html>`;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'; sandbox", 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff' });
  response.end(body);
}

function sendHtml(response: ServerResponse, body: string, nonce: string): void {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', 'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'none'; font-src 'none'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`, 'referrer-policy': 'no-referrer', 'permissions-policy': 'camera=(), microphone=(), geolocation=()', 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff' });
  response.end(body);
}

function parseCookies(header: string | undefined): Record<string, string> {
  return Object.fromEntries((header ?? '').split(';').map((part) => part.trim().split('=')).filter((parts) => parts.length === 2).map(([key, value]) => [key!, value!]));
}

function elapsed(start: string | null, end: string | null): number | null {
  if (!start) return null;
  const value = Date.parse(end ?? new Date().toISOString()) - Date.parse(start);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

interface HttpError extends Error { status: number }
function httpError(status: number, code: string): HttpError { return Object.assign(new Error(code), { status }); }
function isHttpError(error: unknown): error is HttpError { return error instanceof Error && 'status' in error && typeof error.status === 'number'; }
function errorCode(error: unknown): string { const value = error instanceof Error ? error.message : String(error); return /^[A-Z][A-Z0-9_]+$/u.test(value) ? value : 'REVIEW_CONSOLE_FAILED'; }
function safeMessage(error: unknown): string { return (error instanceof Error ? error.message : String(error)).replace(/npm_[A-Za-z0-9_-]+/gu, '[REDACTED]').replace(/[A-Fa-f0-9]{32,}/gu, '[REDACTED]'); }
