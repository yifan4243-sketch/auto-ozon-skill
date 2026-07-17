import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  WorkflowArtifactV2,
  WorkflowRunManifestV2,
  WorkflowStepName,
  WorkflowStepRecordV2,
  WorkflowStepStatus,
  WorkflowStructuredErrorV2,
} from '@auto-ozon/contracts';
import { WORKFLOW_STEP_NAMES } from '@auto-ozon/contracts';
import { resolveRepoRoot } from './repo-root.js';

const WORKFLOW_VERSION = '2.0.0';
const DEFAULT_IMPLEMENTATION_VERSION = '1';
const RUN_LOCK_STALE_MS = 5 * 60_000;

const STEP_DIRECTORIES: Record<WorkflowStepName, string> = {
  'source-1688': '01-source',
  'canonicalize-product': '02-canonical',
  'category-decision': '03-category-decision',
  'cost-pricing': '04-cost-pricing',
  'category-attributes': '05-category-attributes',
  'attribute-mapping': '06-attribute-mapping',
  'draft-generation': '07-draft-generation',
  'listing-submit': '08-listing-submit',
};

export class ArtifactStoreError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ArtifactStoreError';
  }
}

export interface WorkflowStepUpdateV2 {
  status: WorkflowStepStatus;
  output?: string | null;
  input_hash?: string | null;
  dependency_hashes?: Record<string, string>;
  implementation_version?: string;
  started_at?: string | null;
  completed_at?: string | null;
  error?: WorkflowStructuredErrorV2 | null;
  /** @deprecated Compatibility input. Prefer error. */
  error_code?: string | null;
}

export interface ReuseCheckV2 {
  input_hash?: string | null;
  dependency_hashes?: Record<string, string>;
  implementation_version?: string;
}

export interface StepExecutionMetadataV2 {
  input_hash?: string | null;
  dependency_hashes: Record<string, string>;
  implementation_version: string;
}

export interface ArtifactStore {
  readonly runsRoot: string;
  readonly cacheRoot: string;
  ensureRun(runId: string): Promise<WorkflowRunManifestV2>;
  readManifest(runId: string): Promise<WorkflowRunManifestV2 | null>;
  updateStep(runId: string, step: WorkflowStepName, update: WorkflowStepUpdateV2): Promise<WorkflowRunManifestV2>;
  read<T>(runId: string, step: WorkflowStepName, name: string): Promise<T | null>;
  write<T>(runId: string, step: WorkflowStepName, name: string, value: T): Promise<string>;
  exists(runId: string, step: WorkflowStepName, name: string): Promise<boolean>;
  isReusable(runId: string, step: WorkflowStepName, check?: ReuseCheckV2): Promise<boolean>;
  prepareStep(runId: string, step: WorkflowStepName, metadata: StepExecutionMetadataV2): Promise<WorkflowRunManifestV2>;
  markDownstreamStale(runId: string, step: WorkflowStepName): Promise<WorkflowRunManifestV2>;
  withRunLock<T>(runId: string, action: () => Promise<T>): Promise<T>;
  readCache<T>(namespace: string, key: string): Promise<T | null>;
  writeCache<T>(namespace: string, key: string, value: T): Promise<string>;
}

export interface FileArtifactStoreOptions {
  repoRoot?: string;
  runsRoot?: string;
  cacheRoot?: string;
}

export class FileArtifactStore implements ArtifactStore {
  readonly runsRoot: string;
  readonly cacheRoot: string;
  private readonly initializedRuns = new Set<string>();

  constructor(options: FileArtifactStoreOptions = {}) {
    const repoRoot = options.repoRoot ?? resolveRepoRoot();
    this.runsRoot = path.resolve(options.runsRoot ?? path.join(repoRoot, 'data', 'runs'));
    this.cacheRoot = path.resolve(options.cacheRoot ?? path.join(repoRoot, 'data', 'cache'));
  }

  async ensureRun(runId: string): Promise<WorkflowRunManifestV2> {
    assertSafeSegment(runId, 'run ID');
    const raw = await readJsonIfExists<unknown>(this.manifestPath(runId));
    if (raw) {
      const existing = assertManifestV2(raw, runId);
      if (!this.initializedRuns.has(runId)) {
        this.initializedRuns.add(runId);
        if (existing.status === 'running' || Object.values(existing.steps).some((entry) => entry.status === 'running')) {
          return this.recoverInterrupted(existing);
        }
      }
      return existing;
    }
    const createdAt = new Date().toISOString();
    const manifest = createManifest(runId, createdAt);
    await writeJsonAtomic(this.manifestPath(runId), manifest);
    this.initializedRuns.add(runId);
    return manifest;
  }

  async readManifest(runId: string): Promise<WorkflowRunManifestV2 | null> {
    assertSafeSegment(runId, 'run ID');
    const raw = await readJsonIfExists<unknown>(this.manifestPath(runId));
    return raw ? assertManifestV2(raw, runId) : null;
  }

  async updateStep(runId: string, step: WorkflowStepName, update: WorkflowStepUpdateV2): Promise<WorkflowRunManifestV2> {
    const manifest = await this.ensureRun(runId);
    const now = new Date().toISOString();
    const existing = manifest.steps[step];
    const startsNewAttempt = update.status === 'running' && existing.status !== 'running';
    const attemptNumber = startsNewAttempt
      ? existing.current_attempt + 1
      : Math.max(existing.current_attempt, 1);
    const inputHash = update.input_hash ?? existing.input_hash;
    const dependencyHashes = update.dependency_hashes ?? existing.dependency_hashes;
    const implementationVersion = update.implementation_version ?? existing.implementation_version;
    const startedAt = startsNewAttempt ? (update.started_at ?? now) : (update.started_at ?? existing.started_at);
    const completedAt = update.completed_at ?? (isTerminal(update.status) ? now : null);
    const structuredError = update.error ?? (update.error_code
      ? { code: update.error_code, message: update.error_code, recoverable: true }
      : update.error_code === null ? null : existing.error);

    let attempts = existing.attempts;
    if (startsNewAttempt) {
      attempts = [...attempts, {
        attempt: attemptNumber,
        status: 'running',
        input_hash: inputHash,
        dependency_hashes: dependencyHashes,
        implementation_version: implementationVersion,
        artifact: null,
        artifacts: [],
        started_at: startedAt ?? now,
        completed_at: null,
        error: null,
      }];
    }
    attempts = attempts.map((attempt) => attempt.attempt === attemptNumber
      ? {
          ...attempt,
          status: update.status,
          input_hash: inputHash,
          dependency_hashes: dependencyHashes,
          implementation_version: implementationVersion,
          completed_at: completedAt,
          error: structuredError,
        }
      : attempt);

    const nextRecord: WorkflowStepRecordV2 = {
      ...existing,
      status: update.status,
      current_attempt: attemptNumber,
      output: update.output ?? existing.output,
      input_hash: inputHash,
      dependency_hashes: dependencyHashes,
      implementation_version: implementationVersion,
      started_at: startedAt,
      completed_at: completedAt,
      error: structuredError,
      error_code: structuredError?.code ?? null,
      attempts,
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

  async read<T>(runId: string, step: WorkflowStepName, name: string): Promise<T | null> {
    assertSafeFileName(name);
    const manifest = await this.readManifest(runId);
    if (!manifest) return null;
    const record = manifest.steps[step];
    const artifact = record.artifacts.find((entry) => path.posix.basename(entry.path) === name)
      ?? (record.artifact && path.posix.basename(record.artifact.path) === name ? record.artifact : null);
    if (!artifact) return null;
    const file = this.resolveRunRelative(runId, artifact.path);
    const bytes = await readBytesIfExists(file);
    if (!bytes || !matchesArtifact(bytes, artifact)) return null;
    try {
      return JSON.parse(bytes.toString('utf8')) as T;
    } catch {
      return null;
    }
  }

  async write<T>(runId: string, step: WorkflowStepName, name: string, value: T): Promise<string> {
    assertSafeFileName(name);
    let manifest = await this.ensureRun(runId);
    if (manifest.steps[step].current_attempt === 0) {
      manifest = await this.updateStep(runId, step, { status: 'running' });
    }
    const attempt = manifest.steps[step].current_attempt;
    const relative = normalizeRelative(path.join(
      STEP_DIRECTORIES[step],
      `attempt-${String(attempt).padStart(4, '0')}`,
      name,
    ));
    const file = this.resolveRunRelative(runId, relative);
    const text = `${JSON.stringify(value, null, 2)}\n`;
    await writeTextAtomic(file, text);
    const bytes = Buffer.from(text, 'utf8');
    const artifact: WorkflowArtifactV2 = {
      path: relative,
      size_bytes: bytes.byteLength,
      sha256: sha256(bytes),
      schema_id: inferSchemaId(name),
      schema_version: inferSchemaVersion(value),
    };
    const current = (await this.readManifest(runId))!;
    const record = current.steps[step];
    const artifacts = [...record.artifacts.filter((entry) => path.posix.basename(entry.path) !== name), artifact];
    const attempts = record.attempts.map((entry) => entry.attempt === attempt
      ? { ...entry, artifact, artifacts: [...entry.artifacts.filter((item) => path.posix.basename(item.path) !== name), artifact] }
      : entry);
    const next: WorkflowRunManifestV2 = {
      ...current,
      updated_at: new Date().toISOString(),
      steps: {
        ...current.steps,
        [step]: { ...record, output: relative, artifact, artifacts, attempts },
      },
    };
    await writeJsonAtomic(this.manifestPath(runId), next);
    return relative;
  }

  async exists(runId: string, step: WorkflowStepName, name: string): Promise<boolean> {
    return (await this.read(runId, step, name)) !== null;
  }

  async isReusable(runId: string, step: WorkflowStepName, check: ReuseCheckV2 = {}): Promise<boolean> {
    const manifest = await this.readManifest(runId);
    if (!manifest) return false;
    const record = manifest.steps[step];
    if (!['succeeded', 'needs_review', 'skipped'].includes(record.status)) return false;
    if (check.input_hash !== undefined && record.input_hash !== check.input_hash) return false;
    if (check.implementation_version !== undefined && record.implementation_version !== check.implementation_version) return false;
    if (check.dependency_hashes !== undefined && stableJson(record.dependency_hashes) !== stableJson(check.dependency_hashes)) return false;
    if (record.artifacts.length === 0) return false;
    for (const artifact of record.artifacts) {
      const bytes = await readBytesIfExists(this.resolveRunRelative(runId, artifact.path));
      if (!bytes || !matchesArtifact(bytes, artifact)) return false;
    }
    return true;
  }

  async prepareStep(runId: string, step: WorkflowStepName, metadata: StepExecutionMetadataV2): Promise<WorkflowRunManifestV2> {
    const manifest = await this.ensureRun(runId);
    const record = manifest.steps[step];
    const nextInputHash = metadata.input_hash === undefined ? record.input_hash : metadata.input_hash;
    const changed = record.current_attempt > 0 && (
      (metadata.input_hash !== undefined && record.input_hash !== metadata.input_hash)
      || stableJson(record.dependency_hashes) !== stableJson(metadata.dependency_hashes)
      || record.implementation_version !== metadata.implementation_version
    );
    const now = new Date().toISOString();
    const steps = { ...manifest.steps };
    steps[step] = {
      ...record,
      status: changed ? 'stale' : record.status,
      input_hash: nextInputHash,
      dependency_hashes: metadata.dependency_hashes,
      implementation_version: metadata.implementation_version,
      completed_at: changed ? now : record.completed_at,
    };
    if (changed) {
      const boundary = WORKFLOW_STEP_NAMES.indexOf(step);
      for (const downstream of WORKFLOW_STEP_NAMES.slice(boundary + 1)) {
        const downstreamRecord = steps[downstream];
        if (downstreamRecord.status !== 'pending') {
          steps[downstream] = { ...downstreamRecord, status: 'stale', completed_at: now };
        }
      }
    }
    const next = { ...manifest, updated_at: now, steps };
    await writeJsonAtomic(this.manifestPath(runId), next);
    return next;
  }

  async markDownstreamStale(runId: string, step: WorkflowStepName): Promise<WorkflowRunManifestV2> {
    const manifest = await this.ensureRun(runId);
    const boundary = WORKFLOW_STEP_NAMES.indexOf(step);
    const now = new Date().toISOString();
    const steps = { ...manifest.steps };
    for (const downstream of WORKFLOW_STEP_NAMES.slice(boundary + 1)) {
      const record = steps[downstream];
      if (record.status === 'pending') continue;
      steps[downstream] = { ...record, status: 'stale', completed_at: now };
    }
    const next = { ...manifest, updated_at: now, steps };
    await writeJsonAtomic(this.manifestPath(runId), next);
    return next;
  }

  async withRunLock<T>(runId: string, action: () => Promise<T>): Promise<T> {
    assertSafeSegment(runId, 'run ID');
    const lock = path.join(this.runsRoot, runId, '.run.lock');
    await fs.mkdir(path.dirname(lock), { recursive: true });
    await acquireDirectoryLock(lock, runId);
    try {
      return await action();
    } finally {
      await fs.rm(lock, { recursive: true, force: true });
    }
  }

  async readCache<T>(namespace: string, key: string): Promise<T | null> {
    return readJsonIfExists<T>(this.cachePath(namespace, key));
  }

  async writeCache<T>(namespace: string, key: string, value: T): Promise<string> {
    const file = this.cachePath(namespace, key);
    await writeJsonAtomic(file, value);
    return file;
  }

  private async recoverInterrupted(manifest: WorkflowRunManifestV2): Promise<WorkflowRunManifestV2> {
    const now = new Date().toISOString();
    const steps = Object.fromEntries(Object.entries(manifest.steps).map(([name, record]) => {
      if (record.status !== 'running') return [name, record];
      const error = { code: 'STEP_INTERRUPTED', message: 'The previous process ended while this step was running.', recoverable: true };
      return [name, {
        ...record,
        status: 'interrupted',
        completed_at: now,
        error,
        attempts: record.attempts.map((attempt) => attempt.attempt === record.current_attempt
          ? { ...attempt, status: 'interrupted', completed_at: now, error }
          : attempt),
      }];
    })) as Record<WorkflowStepName, WorkflowStepRecordV2>;
    const next = { ...manifest, status: manifest.status === 'running' ? 'interrupted' as const : manifest.status, updated_at: now, steps };
    await writeJsonAtomic(this.manifestPath(manifest.run_id), next);
    return next;
  }

  private manifestPath(runId: string): string {
    return path.join(this.runsRoot, runId, 'manifest.json');
  }

  private resolveRunRelative(runId: string, relative: string): string {
    assertSafeSegment(runId, 'run ID');
    const root = path.resolve(this.runsRoot, runId);
    const resolved = path.resolve(root, relative);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      throw new ArtifactStoreError('ARTIFACT_PATH_INVALID', `Artifact path escapes run root: ${relative}`);
    }
    return resolved;
  }

  private cachePath(namespace: string, key: string): string {
    assertSafeSegment(namespace, 'cache namespace');
    assertSafeSegment(key, 'cache key');
    return path.join(this.cacheRoot, namespace, `${key}.json`);
  }
}

export function createRunId(prefix = 'listing'): string {
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const entropy = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${timestamp}-${entropy}`;
}

export function hashWorkflowValue(value: unknown): string {
  return sha256(Buffer.from(stableJson(value), 'utf8'));
}

function createManifest(runId: string, createdAt: string): WorkflowRunManifestV2 {
  return {
    schema_version: 2,
    run_id: runId,
    workflow: 'listing-preparation',
    workflow_version: WORKFLOW_VERSION,
    current_step: null,
    status: 'pending',
    created_at: createdAt,
    updated_at: createdAt,
    steps: Object.fromEntries(WORKFLOW_STEP_NAMES.map((step) => [step, pendingStep()])) as Record<WorkflowStepName, WorkflowStepRecordV2>,
  };
}

function pendingStep(): WorkflowStepRecordV2 {
  return {
    status: 'pending', current_attempt: 0, output: null, input_hash: null,
    dependency_hashes: {}, implementation_version: DEFAULT_IMPLEMENTATION_VERSION,
    artifact: null, artifacts: [], started_at: null, completed_at: null, error: null, error_code: null, attempts: [],
  };
}

function assertManifestV2(value: unknown, runId: string): WorkflowRunManifestV2 {
  if (!isRecord(value) || value.schema_version !== 2) {
    throw new ArtifactStoreError('LEGACY_RUN_UNSUPPORTED', `Run ${runId} uses a legacy manifest and is read-only. Start a new run.`);
  }
  const steps = isRecord(value.steps) ? value.steps : null;
  if (value.run_id !== runId || !steps || WORKFLOW_STEP_NAMES.some((step) => !isRecord(steps[step]))) {
    throw new ArtifactStoreError('MANIFEST_INVALID', `Run ${runId} has an invalid Manifest V2.`);
  }
  return value as unknown as WorkflowRunManifestV2;
}

async function acquireDirectoryLock(lock: string, runId: string): Promise<void> {
  try {
    await fs.mkdir(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const stat = await fs.stat(lock).catch(() => null);
    if (stat && Date.now() - stat.mtimeMs > RUN_LOCK_STALE_MS) {
      await fs.rm(lock, { recursive: true, force: true });
      await fs.mkdir(lock);
    } else {
      throw new ArtifactStoreError('RUN_LOCKED', `Run ${runId} is already being modified by another process.`);
    }
  }
  await writeJsonAtomic(path.join(lock, 'owner.json'), { pid: process.pid, acquired_at: new Date().toISOString() });
}

async function readJsonIfExists<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function readBytesIfExists(file: string): Promise<Buffer | null> {
  try { return await fs.readFile(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeTextAtomic(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    await fs.writeFile(temporary, text, { encoding: 'utf8', flag: 'wx' });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

function assertSafeSegment(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) throw new ArtifactStoreError('PATH_SEGMENT_INVALID', `Invalid ${label}: ${value}`);
}

function assertSafeFileName(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(value)) throw new ArtifactStoreError('ARTIFACT_NAME_INVALID', `Invalid artifact file name: ${value}`);
}

function normalizeRelative(value: string): string { return value.replaceAll('\\', '/'); }
function isTerminal(status: WorkflowStepStatus): boolean { return ['succeeded', 'needs_review', 'blocked', 'failed', 'skipped', 'interrupted', 'stale'].includes(status); }
function sha256(value: Buffer): string { return crypto.createHash('sha256').update(value).digest('hex'); }
function matchesArtifact(value: Buffer, artifact: WorkflowArtifactV2): boolean { return value.byteLength === artifact.size_bytes && sha256(value) === artifact.sha256; }
function inferSchemaId(name: string): string { return name.replace(/\.json$/u, ''); }
function inferSchemaVersion(value: unknown): number { return isRecord(value) && typeof value.schema_version === 'number' ? value.schema_version : 1; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
