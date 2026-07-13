import type { CommandResult } from '@auto-ozon/contracts';
import type { WorkflowContext } from '@auto-ozon/artifact-store';
export {
  assertWorkflowActive,
  silentWorkflowLogger,
  type WorkflowContext,
  type WorkflowLogger,
} from '@auto-ozon/artifact-store';

export interface WorkflowStep<I, O> {
  readonly name: string;
  readonly version: number;
  execute(input: I, context: WorkflowContext): Promise<CommandResult<O>>;
}
