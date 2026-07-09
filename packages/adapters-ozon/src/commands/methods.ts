import {
  OZON_MCP_TOOLS,
  errorResult,
  mcpToolError,
  okResult,
  sanitizeSecretText,
} from '../config.js';
import { withPcdckClient } from '../mcp/pcdck-client.js';
import { parseToolResult } from '../mcp/parse-tool-result.js';
import type {
  OzonCommandResult,
  OzonDescribeMethodOptions,
  OzonSearchMethodsOptions,
} from '../types.js';

export async function ozonSearchMethods(
  options: OzonSearchMethodsOptions,
): Promise<OzonCommandResult> {
  try {
    return await withPcdckClient(async (client) => {
      const result = await client.callTool(OZON_MCP_TOOLS.searchMethods, {
        query: options.query,
        ...(options.limit === undefined ? {} : { limit: options.limit }),
      });
      const parsed = parseToolResult(result);
      if (parsed.isError) return mcpToolError('ozon.methods.search', parsed.data);
      return okResult('ozon.methods.search', parsed.data);
    });
  } catch (error) {
    return errorResult('ozon.methods.search', {
      code: 'OZON_MCP_CALL_FAILED',
      message: sanitizeSecretText(error),
      recoverable: true,
    });
  }
}

export async function ozonDescribeMethod(
  options: OzonDescribeMethodOptions,
): Promise<OzonCommandResult> {
  try {
    return await withPcdckClient(async (client) => {
      const result = await client.callTool(OZON_MCP_TOOLS.describeMethod, {
        operation_id: options.operationId,
      });
      const parsed = parseToolResult(result);
      if (parsed.isError) return mcpToolError('ozon.methods.describe', parsed.data);
      return okResult('ozon.methods.describe', parsed.data);
    });
  } catch (error) {
    return errorResult('ozon.methods.describe', {
      code: 'OZON_MCP_CALL_FAILED',
      message: sanitizeSecretText(error),
      recoverable: true,
    });
  }
}
