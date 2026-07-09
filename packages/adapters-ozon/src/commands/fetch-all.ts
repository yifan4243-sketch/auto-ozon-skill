import {
  OZON_MCP_TOOLS,
  errorResult,
  isOzonErrorPayload,
  mcpToolError,
  okResult,
  sanitizeSecretText,
} from '../config.js';
import { withPcdckClient } from '../mcp/pcdck-client.js';
import { parseToolResult } from '../mcp/parse-tool-result.js';
import type { OzonCommandResult, OzonFetchAllOptions } from '../types.js';
import { ensureExecutionToolAndReadSafety } from './call.js';

export async function ozonFetchAll(
  options: OzonFetchAllOptions,
): Promise<OzonCommandResult> {
  try {
    return await withPcdckClient(async (client) => {
      const guard = await ensureExecutionToolAndReadSafety(
        client,
        OZON_MCP_TOOLS.fetchAll,
        'ozon.fetchAll',
        options.operationId,
      );
      if (guard) return guard;

      const result = await client.callTool(OZON_MCP_TOOLS.fetchAll, {
        operation_id: options.operationId,
        params: options.params,
        ...(options.maxItems === undefined ? {} : { max_items: options.maxItems }),
      });
      const parsed = parseToolResult(result);
      if (parsed.isError || isOzonErrorPayload(parsed.data)) {
        return mcpToolError('ozon.fetchAll', parsed.data);
      }
      return okResult('ozon.fetchAll', parsed.data);
    });
  } catch (error) {
    return errorResult('ozon.fetchAll', {
      code: 'OZON_MCP_CALL_FAILED',
      message: sanitizeSecretText(error),
      recoverable: true,
    });
  }
}
