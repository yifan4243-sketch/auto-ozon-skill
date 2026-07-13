import type { ArtifactStore } from './store.js';

export interface WorkflowLogger {
  info(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
}

export interface WorkflowContext {
  run_id: string;
  artifact_store: ArtifactStore;
  logger: WorkflowLogger;
  force_refresh: boolean;
  signal?: AbortSignal;
}

export const silentWorkflowLogger: WorkflowLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export function assertWorkflowActive(context: WorkflowContext): void {
  if (context.signal?.aborted) {
    throw new Error(`Workflow ${context.run_id} was aborted.`);
  }
}
