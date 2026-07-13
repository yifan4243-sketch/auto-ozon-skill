import type { CommandResult } from '../../contracts/src/command-result.js';
import type { WorkflowContext } from '../../artifact-store/src/execution-context.js';
export {
  assertWorkflowActive,
  silentWorkflowLogger,
  type WorkflowContext,
  type WorkflowLogger,
} from '../../artifact-store/src/execution-context.js';

export interface WorkflowStep<I, O> {
  readonly name: string;
  readonly version: number;
  execute(input: I, context: WorkflowContext): Promise<CommandResult<O>>;
}
