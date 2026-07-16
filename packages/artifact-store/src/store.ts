import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  WorkflowRunManifestV1,
  WorkflowStepName,
  WorkflowStepRecordV1,
  WorkflowStepStatus,
} from '@auto-ozon/contracts';
import { WORKFLOW_STEP_NAMES } from '@auto-ozon/contracts';
import { resolveRepoRoot } from './repo-root.js';

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

export interface ArtifactStore {
  readonly runsRoot: string;
  readonly cacheRoot: string;
  ensureRun(runId: string): Promise<WorkflowRunManifestV1>;
  readManifest(runId: string): Promise<WorkflowRunManifestV1 | null>;
  updateStep(
    runId: string,
    step: WorkflowStepName,
    update: Partial<WorkflowStepRecordV1> & { status: WorkflowStepStatus },
  ): Promise<WorkflowRunManifestV1>;
  read<T>(runId: string, step: WorkflowStepName, name: string): Promise<T | null>;
  write<T>(runId: string, step: WorkflowStepName, name: string, value: T): Promise<string>;
  exists(runId: string, step: WorkflowStepName, name: string): Promise<boolean>;
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

  constructor(options: FileArtifactStoreOptions = {}) {
    const repoRoot = options.repoRoot ?? resolveRepoRoot();
    this.runsRoot = path.resolve(options.runsRoot ?? path.join(repoRoot, 'data', 'runs'));
    this.cacheRoot = path.resolve(options.cacheRoot ?? path.join(repoRoot, 'data', 'cache'));
  }

  async ensureRun(runId: string): Promise<WorkflowRunManifestV1> {
    assertSafeSegment(runId, 'run ID');
    const existing = await this.readManifest(runId);
    if (existing) return existing;
    const createdAt = new Date().toISOString();
    const manifest = createManifest(runId, createdAt);
    await writeJsonAtomic(this.manifestPath(runId), manifest);
    return manifest;
  }

  async readManifest(runId: string): Promise<WorkflowRunManifestV1 | null> {
    assertSafeSegment(runId, 'run ID');
    return readJsonIfExists<WorkflowRunManifestV1>(this.manifestPath(runId));
  }

  async updateStep(
    runId: string,
    step: WorkflowStepName,
    update: Partial<WorkflowStepRecordV1> & { status: WorkflowStepStatus },
  ): Promise<WorkflowRunManifestV1> {
    const manifest = await this.ensureRun(runId);
    const now = new Date().toISOString();
    const existingRecord = manifest.steps[step] ?? pendingStep();
    const nextRecord: WorkflowStepRecordV1 = {
      ...existingRecord,
      ...update,
      started_at:
        update.started_at ??
        existingRecord.started_at ??
        (update.status === 'running' ? now : null),
      completed_at:
        update.completed_at ??
        (isTerminal(update.status) ? now : existingRecord.completed_at),
    };
    const next: WorkflowRunManifestV1 = {
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
    return readJsonIfExists<T>(this.artifactPath(runId, step, name));
  }

  async write<T>(runId: string, step: WorkflowStepName, name: string, value: T): Promise<string> {
    const file = this.artifactPath(runId, step, name);
    await writeJsonAtomic(file, value);
    return normalizeRelative(path.relative(path.join(this.runsRoot, runId), file));
  }

  async exists(runId: string, step: WorkflowStepName, name: string): Promise<boolean> {
    try {
      await fs.access(this.artifactPath(runId, step, name));
      return true;
    } catch {
      return false;
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

  private manifestPath(runId: string): string {
    return path.join(this.runsRoot, runId, 'manifest.json');
  }

  private artifactPath(runId: string, step: WorkflowStepName, name: string): string {
    assertSafeSegment(runId, 'run ID');
    assertSafeFileName(name);
    return path.join(this.runsRoot, runId, STEP_DIRECTORIES[step], name);
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

function createManifest(runId: string, createdAt: string): WorkflowRunManifestV1 {
  return {
    schema_version: 1,
    run_id: runId,
    workflow: 'listing-preparation',
    current_step: null,
    status: 'pending',
    created_at: createdAt,
    updated_at: createdAt,
    steps: Object.fromEntries(WORKFLOW_STEP_NAMES.map((step) => [step, pendingStep()])) as Record<
      WorkflowStepName,
      WorkflowStepRecordV1
    >,
  };
}

function pendingStep(): WorkflowStepRecordV1 {
  return { status: 'pending', output: null, started_at: null, completed_at: null, error_code: null };
}

async function readJsonIfExists<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

function assertSafeSegment(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

function assertSafeFileName(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(value)) {
    throw new Error(`Invalid artifact file name: ${value}`);
  }
}

function normalizeRelative(value: string): string {
  return value.replaceAll('\\', '/');
}

function isTerminal(status: WorkflowStepStatus): boolean {
  return ['succeeded', 'needs_review', 'blocked', 'failed', 'skipped'].includes(status);
}
