export const WORKFLOW_STEP_NAMES = [
  'source-1688',
  'canonicalize-product',
  'category-decision',
  'category-attributes',
  'attribute-mapping',
] as const;

export type WorkflowStepName = (typeof WORKFLOW_STEP_NAMES)[number];

export type WorkflowStepStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'needs_review'
  | 'blocked'
  | 'failed'
  | 'skipped';

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
