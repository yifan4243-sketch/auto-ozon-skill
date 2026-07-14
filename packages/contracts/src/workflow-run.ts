export const WORKFLOW_STEP_NAMES = [
  'source-1688',
  'canonicalize-product',
  'category-decision',
  'category-attributes',
  'attribute-mapping',
  'draft-generation',
  'listing-payload',
  'ozon-publish',
] as const;

export type WorkflowStepName = (typeof WORKFLOW_STEP_NAMES)[number];

export type WorkflowStepStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'needs_review'
  | 'blocked'
  | 'failed'
  | 'skipped'
  | 'stale'
  | 'interrupted';

export interface WorkflowStepRecordV1 {
  status: WorkflowStepStatus;
  output: string | null;
  started_at: string | null;
  completed_at: string | null;
  error_code: string | null;
}

export interface WorkflowRunManifestV1 {
  schema_version: 1;
  run_id: string;
  workflow: 'listing-preparation';
  current_step: WorkflowStepName | null;
  status: WorkflowStepStatus;
  created_at: string;
  updated_at: string;
  steps: Record<WorkflowStepName, WorkflowStepRecordV1>;
}

export interface WorkflowArtifactRecordV2 {
  path: string;
  schema_id: string;
  schema_version: number;
  sha256: string;
  size_bytes: number;
}

export interface WorkflowStepErrorV2 {
  code: string;
  message: string;
  recoverable: boolean;
  detail?: unknown;
}

export interface WorkflowStepRecordV2 {
  status: WorkflowStepStatus;
  step_version: string;
  attempt: number;
  input_sha256: string | null;
  dependency_sha256: Record<string, string>;
  artifact: WorkflowArtifactRecordV2 | null;
  started_at: string | null;
  completed_at: string | null;
  error: WorkflowStepErrorV2 | null;
  /** @deprecated Use artifact.path. */
  output: string | null;
  /** @deprecated Use error.code. */
  error_code: string | null;
}

export interface WorkflowRunManifestV2 {
  schema_version: 2;
  run_id: string;
  workflow: 'listing-publication';
  workflow_version: string;
  build_version: string;
  current_step: WorkflowStepName | null;
  status: WorkflowStepStatus;
  created_at: string;
  updated_at: string;
  steps: Record<WorkflowStepName, WorkflowStepRecordV2>;
}
