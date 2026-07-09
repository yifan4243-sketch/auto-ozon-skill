import {
  OZON_MCP_TOOLS,
  errorResult,
  executionToolsDisabled,
  extractSafety,
  extractToolNames,
  isOzonErrorPayload,
  mcpToolError,
  okResult,
  sanitizeSecretText,
  writeBlocked,
} from '../config.js';
import type { PcdckOzonMcpClient } from '../mcp/pcdck-client.js';
import { withPcdckClient } from '../mcp/pcdck-client.js';
import { parseToolResult } from '../mcp/parse-tool-result.js';
import type { OzonCallMethodOptions, OzonCommandResult } from '../types.js';

export async function ozonCallMethod(
  options: OzonCallMethodOptions,
): Promise<OzonCommandResult> {
  try {
    return await withPcdckClient(async (client) => {
      const guard = await ensureExecutionToolAndReadSafety(
        client,
        OZON_MCP_TOOLS.callMethod,
        'ozon.call',
        options.operationId,
      );
      if (guard) return guard;

      const result = await client.callTool(OZON_MCP_TOOLS.callMethod, {
        operation_id: options.operationId,
        params: options.params,
      });
      const parsed = parseToolResult(result);
      if (parsed.isError || isOzonErrorPayload(parsed.data)) {
        return mcpToolError('ozon.call', parsed.data);
      }
      return okResult('ozon.call', parsed.data);
    });
  } catch (error) {
    return errorResult('ozon.call', {
      code: 'OZON_MCP_CALL_FAILED',
      message: sanitizeSecretText(error),
      recoverable: true,
    });
  }
}

export async function ensureExecutionToolAndReadSafety(
  client: PcdckOzonMcpClient,
  toolName: string,
  command: string,
  operationId: string,
): Promise<OzonCommandResult | null> {
  const tools = await client.listTools();
  const names = extractToolNames(tools);
  if (!names.includes(toolName)) return executionToolsDisabled(command);

  const describeResult = await client.callTool(OZON_MCP_TOOLS.describeMethod, {
    operation_id: operationId,
  });
  const parsedDescribe = parseToolResult(describeResult);
  if (parsedDescribe.isError || isOzonErrorPayload(parsedDescribe.data)) {
    return mcpToolError(command, parsedDescribe.data);
  }

  const safety = extractSafety(parsedDescribe.data);
  if (safety !== 'read') return writeBlocked(command);
  return null;
}
