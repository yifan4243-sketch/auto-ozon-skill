export const WORKFLOW_STEP_NAMES = [
  'source-1688',
  'canonicalize-product',
  'category-decision',
  'cost-pricing',
  'category-attributes',
  'attribute-mapping',
  'draft-generation',
  'listing-submit',
] as const;

export type WorkflowStepName = (typeof WORKFLOW_STEP_NAMES)[number];

export type WorkflowStepStatus =
  | 'pending'
  | 'running'
  | 'interrupted'
  | 'stale'
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

export interface WorkflowArtifactV2 {
  path: string;
  size_bytes: number;
  sha256: string;
  schema_id: string;
  schema_version: number;
}

export interface WorkflowStructuredErrorV2 extends DomainErrorV1 {}

/** Public production contract names retained independently from manifest naming. */
export type StepAttemptV1 = WorkflowStepAttemptV2;
export type ArtifactMetadataV1 = WorkflowArtifactV2;

export interface WorkflowStepAttemptV2 {
  attempt: number;
  status: WorkflowStepStatus;
  input_hash: string | null;
  dependency_hashes: Record<string, string>;
  implementation_version: string;
  artifact: WorkflowArtifactV2 | null;
  artifacts: WorkflowArtifactV2[];
  started_at: string;
  completed_at: string | null;
  error: WorkflowStructuredErrorV2 | null;
}

export interface WorkflowStepRecordV2 {
  status: WorkflowStepStatus;
  current_attempt: number;
  output: string | null;
  input_hash: string | null;
  dependency_hashes: Record<string, string>;
  implementation_version: string;
  artifact: WorkflowArtifactV2 | null;
  artifacts: WorkflowArtifactV2[];
  started_at: string | null;
  completed_at: string | null;
  error: WorkflowStructuredErrorV2 | null;
  /** @deprecated Read error.code instead. */
  error_code: string | null;
  attempts: WorkflowStepAttemptV2[];
}

export interface WorkflowRunManifestV2 {
  schema_version: 2;
  run_id: string;
  workflow: 'listing-preparation';
  workflow_version: string;
  current_step: WorkflowStepName | null;
  status: WorkflowStepStatus;
  created_at: string;
  updated_at: string;
  steps: Record<WorkflowStepName, WorkflowStepRecordV2>;
}
import type { DomainErrorV1 } from './domain-error-v1.js';
