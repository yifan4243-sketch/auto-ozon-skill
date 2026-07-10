import { OZON_MCP_TOOLS } from '../config.js';
import type {
  OzonCommandResult,
  OzonGetWorkflowOptions,
  OzonListWorkflowsOptions,
} from '../types.js';
import { callOzonMcpTool } from './tool-call.js';

export async function ozonListWorkflows(
  options: OzonListWorkflowsOptions = {},
): Promise<OzonCommandResult> {
  return callOzonMcpTool('ozon.workflows.list', OZON_MCP_TOOLS.listWorkflows, {
    ...(options.category === undefined ? {} : { category: options.category }),
  });
}

export async function ozonGetWorkflow(
  options: OzonGetWorkflowOptions,
): Promise<OzonCommandResult> {
  return callOzonMcpTool('ozon.workflows.get', OZON_MCP_TOOLS.getWorkflow, {
    name: options.name,
  });
}
