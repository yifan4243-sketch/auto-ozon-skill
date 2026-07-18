import type { ListingBatchResultV1, WorkflowRunManifestV2 } from '@auto-ozon/contracts';
import type { PostgresQueryClientV1 } from '@auto-ozon/job-store';
import type { ReviewConsoleStateReaderV1, ReviewConsoleStateSnapshotV1 } from './review-console.js';

/** Durable read model for team review-console deployments. The caller owns the
 * PostgreSQL pool and OIDC middleware; no database credential is ever exposed
 * to the browser. */
export class PostgresReviewConsoleStateReader implements ReviewConsoleStateReaderV1 {
  constructor(private readonly client: PostgresQueryClientV1) {}

  async readOverview(): Promise<ReviewConsoleStateSnapshotV1> {
    const [jobs, runs] = await Promise.all([
      this.client.query<{ result_json: unknown }>(
        'SELECT result_json FROM listing_jobs WHERE result_json IS NOT NULL ORDER BY updated_at DESC',
      ),
      this.client.query<{ manifest_json: unknown }>(
        'SELECT manifest_json FROM workflow_runs ORDER BY updated_at DESC',
      ),
    ]);
    return {
      batches: jobs.rows.map((row) => decodeJson<ListingBatchResultV1>(row.result_json)),
      runs: runs.rows.map((row) => summarizeRun(decodeJson<WorkflowRunManifestV2>(row.manifest_json))),
    };
  }

  async readRun(runId: string): Promise<unknown | null> {
    const run = await this.client.query<{ manifest_json: unknown }>(
      'SELECT manifest_json FROM workflow_runs WHERE run_id=$1',
      [runId],
    );
    if (!run.rows[0]) return null;
    const attempts = await this.client.query<Record<string, unknown>>(
      'SELECT step_name,attempt,status,input_hash,dependency_hashes_json,implementation_version,artifact_json,started_at,completed_at,error_json FROM workflow_step_attempts WHERE run_id=$1 ORDER BY step_name,attempt',
      [runId],
    );
    return {
      manifest: decodeJson<WorkflowRunManifestV2>(run.rows[0].manifest_json),
      step_attempts: attempts.rows,
    };
  }
}

function decodeJson<T>(value: unknown): T {
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

function summarizeRun(manifest: WorkflowRunManifestV2): unknown {
  return {
    run_id: manifest.run_id,
    status: manifest.status,
    current_step: manifest.current_step,
    updated_at: manifest.updated_at,
    steps: Object.entries(manifest.steps).map(([name, step]) => ({
      name,
      status: step.status,
      attempt: step.current_attempt,
      elapsed_ms: elapsed(step.started_at, step.completed_at),
      error: step.error,
    })),
  };
}

function elapsed(startedAt: string | null, completedAt: string | null): number | null {
  if (!startedAt || !completedAt) return null;
  return Math.max(0, Date.parse(completedAt) - Date.parse(startedAt));
}
