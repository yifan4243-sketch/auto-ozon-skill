import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import type {
  WorkflowArtifactRecordV2,
  WorkflowRunManifestV2,
  WorkflowStepErrorV2,
  WorkflowStepName,
  WorkflowStepRecordV2,
  WorkflowStepStatus,
} from '@auto-ozon/contracts';
import { WORKFLOW_STEP_NAMES } from '@auto-ozon/contracts';
import { resolveRepoRoot } from './repo-root.js';

const STEP_DIRECTORIES: Record<WorkflowStepName, string> = {
  'source-1688': '01-source',
  'canonicalize-product': '02-canonical',
  'category-decision': '03-category-decision',
  'category-attributes': '04-category-attributes',
  'attribute-mapping': '05-attribute-mapping',
  'draft-generation': '06-draft',
  'listing-payload': '07-listing-payload',
  'ozon-publish': '08-ozon-publish',
};

export class LegacyRunUnsupportedError extends Error {
  readonly code = 'LEGACY_RUN_UNSUPPORTED';
  constructor(runId: string) {
    super(`Run ${runId} uses an unsupported legacy manifest. Start a new run.`);
  }
}

export interface StepUpdateV2 {
  status: WorkflowStepStatus;
  step_version?: string;
  input_sha256?: string | null;
  dependency_sha256?: Record<string, string>;
  output?: string | null;
  artifact?: WorkflowArtifactRecordV2 | null;
  started_at?: string | null;
  completed_at?: string | null;
  error?: WorkflowStepErrorV2 | null;
  error_code?: string | null;
}

export interface ArtifactStore {
  readonly runsRoot: string;
  readonly cacheRoot: string;
  ensureRun(runId: string): Promise<WorkflowRunManifestV2>;
  readManifest(runId: string): Promise<WorkflowRunManifestV2 | null>;
  updateStep(runId: string, step: WorkflowStepName, update: StepUpdateV2): Promise<WorkflowRunManifestV2>;
  markStaleFrom(runId: string, step: WorkflowStepName): Promise<WorkflowRunManifestV2>;
  read<T>(runId: string, step: WorkflowStepName, name: string): Promise<T | null>;
  write<T>(runId: string, step: WorkflowStepName, name: string, value: T): Promise<string>;
  exists(runId: string, step: WorkflowStepName, name: string): Promise<boolean>;
  readCache<T>(namespace: string, key: string): Promise<T | null>;
  writeCache<T>(namespace: string, key: string, value: T): Promise<string>;
  withRunLock<T>(runId: string, work: () => Promise<T>): Promise<T>;
}

export interface FileArtifactStoreOptions {
  repoRoot?: string;
  runsRoot?: string;
  cacheRoot?: string;
  workflowVersion?: string;
  buildVersion?: string;
}

export class FileArtifactStore implements ArtifactStore {
  readonly runsRoot: string;
  readonly cacheRoot: string;
  private readonly workflowVersion: string;
  private readonly buildVersion: string;
  private readonly recoveredRuns = new Set<string>();

  constructor(options: FileArtifactStoreOptions = {}) {
    const repoRoot = options.repoRoot ?? resolveRepoRoot();
    this.runsRoot = path.resolve(options.runsRoot ?? path.join(repoRoot, 'data', 'runs'));
    this.cacheRoot = path.resolve(options.cacheRoot ?? path.join(repoRoot, 'data', 'cache'));
    this.workflowVersion = options.workflowVersion ?? '2.0.0';
    this.buildVersion = options.buildVersion ?? process.env.AUTO_OZON_BUILD_VERSION ?? 'development';
  }

  async ensureRun(runId: string): Promise<WorkflowRunManifestV2> {
    assertSafeSegment(runId, 'run ID');
    const existing = await this.readManifest(runId);
    if (existing) {
      if (this.recoveredRuns.has(runId)) return existing;
      this.recoveredRuns.add(runId);
      return this.recoverInterrupted(existing);
    }
    const createdAt = new Date().toISOString();
    const manifest = createManifest(runId, createdAt, this.workflowVersion, this.buildVersion);
    await writeJsonAtomic(this.manifestPath(runId), manifest);
    this.recoveredRuns.add(runId);
    return manifest;
  }

  async readManifest(runId: string): Promise<WorkflowRunManifestV2 | null> {
    assertSafeSegment(runId, 'run ID');
    const value = await readJsonIfExists<unknown>(this.manifestPath(runId));
    if (value === null) return null;
    if (!isRecord(value) || value.schema_version !== 2) throw new LegacyRunUnsupportedError(runId);
    return value as unknown as WorkflowRunManifestV2;
  }

  async updateStep(runId: string, step: WorkflowStepName, update: StepUpdateV2): Promise<WorkflowRunManifestV2> {
    const manifest = await this.ensureRun(runId);
    const now = new Date().toISOString();
    const previous = manifest.steps[step];
    const attempt = update.status === 'running' && previous.status !== 'running'
      ? previous.attempt + 1
      : previous.attempt;
    let artifact = update.artifact ?? previous.artifact;
    if (update.output) artifact = await this.describeArtifact(runId, update.output);
    const error = update.error ?? (update.error_code
      ? { code: update.error_code, message: update.error_code, recoverable: true }
      : update.error_code === null ? null : previous.error);
    const nextRecord: WorkflowStepRecordV2 = {
      ...previous,
      status: update.status,
      step_version: update.step_version ?? previous.step_version,
      attempt,
      input_sha256: update.input_sha256 ?? previous.input_sha256,
      dependency_sha256: update.dependency_sha256 ?? previous.dependency_sha256,
      artifact,
      started_at: update.status === 'running' ? (update.started_at ?? now) : previous.started_at,
      completed_at: isTerminal(update.status) ? (update.completed_at ?? now) : null,
      error,
      output: artifact?.path ?? null,
      error_code: error?.code ?? null,
    };
    const next: WorkflowRunManifestV2 = {
      ...manifest,
      current_step: step,
      status: update.status,
      updated_at: now,
      steps: { ...manifest.steps, [step]: nextRecord },
    };
    await writeJsonAtomic(this.manifestPath(runId), next);
    return next;
  }

  async markStaleFrom(runId: string, step: WorkflowStepName): Promise<WorkflowRunManifestV2> {
    const manifest = await this.ensureRun(runId);
    const start = WORKFLOW_STEP_NAMES.indexOf(step);
    const now = new Date().toISOString();
    const steps = { ...manifest.steps };
    for (const name of WORKFLOW_STEP_NAMES.slice(start)) {
      steps[name] = { ...steps[name], status: 'stale', completed_at: now, error: null };
    }
    const next = { ...manifest, current_step: step, status: 'stale' as const, updated_at: now, steps };
    await writeJsonAtomic(this.manifestPath(runId), next);
    return next;
  }

  async read<T>(runId: string, step: WorkflowStepName, name: string): Promise<T | null> {
    assertSafeFileName(name);
    const manifest = await this.readManifest(runId);
    if (!manifest) return null;
    const record = manifest.steps[step];
    if (record.attempt < 1) return null;
    const file = this.attemptArtifactPath(runId, step, record.attempt, name);
    let value: T | null;
    try { value = await readJsonIfExists<T>(file); }
    catch { return null; }
    if (value === null) return null;
    if (record.artifact?.path.endsWith(`/${name}`)) {
      const actual = await describeFile(file, record.artifact.schema_id, record.artifact.schema_version, this.runRoot(runId));
      if (actual.sha256 !== record.artifact.sha256 || actual.size_bytes !== record.artifact.size_bytes) return null;
    }
    return value;
  }

  async write<T>(runId: string, step: WorkflowStepName, name: string, value: T): Promise<string> {
    assertSafeFileName(name);
    let manifest = await this.ensureRun(runId);
    if (manifest.steps[step].attempt === 0) {
      manifest = await this.updateStep(runId, step, { status: 'running' });
    }
    const attempt = manifest.steps[step].attempt;
    const file = this.attemptArtifactPath(runId, step, attempt, name);
    await writeJsonAtomic(file, value);
    return normalizeRelative(path.relative(this.runRoot(runId), file));
  }

  async exists(runId: string, step: WorkflowStepName, name: string): Promise<boolean> {
    return (await this.read<unknown>(runId, step, name)) !== null;
  }

  async readCache<T>(namespace: string, key: string): Promise<T | null> {
    try { return await readJsonIfExists<T>(this.cachePath(namespace, key)); }
    catch { return null; }
  }

  async writeCache<T>(namespace: string, key: string, value: T): Promise<string> {
    const file = this.cachePath(namespace, key);
    await writeJsonAtomic(file, value);
    return file;
  }

  async withRunLock<T>(runId: string, work: () => Promise<T>): Promise<T> {
    assertSafeSegment(runId, 'run ID');
    const root = this.runRoot(runId);
    await fs.mkdir(root, { recursive: true });
    let release: (() => Promise<void>) | undefined;
    try {
      release = await lockfile.lock(root, { realpath: false, retries: 0, stale: 60_000 });
    } catch (error) {
      const wrapped = new Error(`Run ${runId} is already locked.`);
      (wrapped as Error & { code?: string }).code = 'RUN_LOCKED';
      throw wrapped;
    }
    try { return await work(); }
    finally { await release(); }
  }

  private async recoverInterrupted(manifest: WorkflowRunManifestV2): Promise<WorkflowRunManifestV2> {
    const running = WORKFLOW_STEP_NAMES.filter((step) => manifest.steps[step].status === 'running');
    if (running.length === 0) return manifest;
    const now = new Date().toISOString();
    const steps = { ...manifest.steps };
    for (const step of running) {
      steps[step] = {
        ...steps[step], status: 'interrupted', completed_at: now,
        error: { code: 'STEP_INTERRUPTED', message: 'Previous process stopped during this step.', recoverable: true },
      };
    }
    const next = { ...manifest, status: 'interrupted' as const, updated_at: now, steps };
    await writeJsonAtomic(this.manifestPath(manifest.run_id), next);
    return next;
  }

  private async describeArtifact(runId: string, relative: string): Promise<WorkflowArtifactRecordV2> {
    const file = path.resolve(this.runRoot(runId), relative);
    if (!file.startsWith(`${this.runRoot(runId)}${path.sep}`)) throw new Error('Artifact path escapes run root.');
    const json = await readJsonIfExists<Record<string, unknown>>(file);
    return describeFile(file, path.basename(file, '.json'), Number(json?.schema_version ?? 1), this.runRoot(runId));
  }

  private manifestPath(runId: string) { return path.join(this.runRoot(runId), 'manifest.json'); }
  private runRoot(runId: string) { return path.join(this.runsRoot, runId); }
  private attemptArtifactPath(runId: string, step: WorkflowStepName, attempt: number, name: string) {
    return path.join(this.runRoot(runId), STEP_DIRECTORIES[step], 'attempts', String(attempt).padStart(4, '0'), name);
  }
  private cachePath(namespace: string, key: string) {
    assertSafeSegment(namespace, 'cache namespace'); assertSafeSegment(key, 'cache key');
    return path.join(this.cacheRoot, namespace, `${key}.json`);
  }
}

export function createRunId(prefix = 'listing'): string {
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `${prefix}-${timestamp}-${crypto.randomBytes(4).toString('hex')}`;
}

export function sha256Json(value: unknown): string {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function createManifest(runId: string, at: string, workflowVersion: string, buildVersion: string): WorkflowRunManifestV2 {
  const pending = (): WorkflowStepRecordV2 => ({
    status: 'pending', step_version: '1.0.0', attempt: 0, input_sha256: null,
    dependency_sha256: {}, artifact: null, started_at: null, completed_at: null, error: null,
    output: null, error_code: null,
  });
  return {
    schema_version: 2, run_id: runId, workflow: 'listing-publication', workflow_version: workflowVersion,
    build_version: buildVersion, current_step: null, status: 'pending', created_at: at, updated_at: at,
    steps: Object.fromEntries(WORKFLOW_STEP_NAMES.map((step) => [step, pending()])) as Record<WorkflowStepName, WorkflowStepRecordV2>,
  };
}

async function readJsonIfExists<T>(file: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  try { await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }); }
}

async function describeFile(file: string, schemaId: string, schemaVersion: number, runRoot: string): Promise<WorkflowArtifactRecordV2> {
  const content = await fs.readFile(file);
  return { path: normalizeRelative(path.relative(runRoot, file)), schema_id: schemaId, schema_version: schemaVersion,
    sha256: crypto.createHash('sha256').update(content).digest('hex'), size_bytes: content.byteLength };
}

function assertSafeSegment(value: string, label: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) throw new Error(`Invalid ${label}: ${value}`);
}
function assertSafeFileName(value: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(value)) throw new Error(`Invalid artifact file name: ${value}`);
}
function normalizeRelative(value: string) { return value.replaceAll('\\', '/'); }
function isTerminal(status: WorkflowStepStatus) { return ['succeeded','needs_review','blocked','failed','skipped','stale','interrupted'].includes(status); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item === undefined ? null : item)).join(',')}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined && typeof value[key] !== 'function')
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
