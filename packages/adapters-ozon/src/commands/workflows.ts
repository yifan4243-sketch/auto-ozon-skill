import {
  OZON_MCP_TOOLS,
  errorResult,
  mcpToolError,
  okResult,
  sanitizeSecretText,
} from '../config.js';
import { withPcdckClient } from '../mcp/pcdck-client.js';
import { parseToolResult } from '../mcp/parse-tool-result.js';
import type { OzonCommandResult, OzonGetWorkflowOptions } from '../types.js';

export async function ozonListWorkflows(): Promise<OzonCommandResult> {
  try {
    return await withPcdckClient(async (client) => {
      const result = await client.callTool(OZON_MCP_TOOLS.listWorkflows, {});
      const parsed = parseToolResult(result);
      if (parsed.isError) return mcpToolError('ozon.workflows.list', parsed.data);
      return okResult('ozon.workflows.list', parsed.data);
    });
  } catch (error) {
    return errorResult('ozon.workflows.list', {
      code: 'OZON_MCP_CALL_FAILED',
      message: sanitizeSecretText(error),
      recoverable: true,
    });
  }
}

export async function ozonGetWorkflow(
  options: OzonGetWorkflowOptions,
): Promise<OzonCommandResult> {
  try {
    return await withPcdckClient(async (client) => {
      const result = await client.callTool(OZON_MCP_TOOLS.getWorkflow, { name: options.name });
      const parsed = parseToolResult(result);
      if (parsed.isError) return mcpToolError('ozon.workflows.get', parsed.data);
      return okResult('ozon.workflows.get', parsed.data);
    });
  } catch (error) {
    return errorResult('ozon.workflows.get', {
      code: 'OZON_MCP_CALL_FAILED',
      message: sanitizeSecretText(error),
      recoverable: true,
    });
  }
}
