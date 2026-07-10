import {
  errorResult,
  isOzonErrorPayload,
  mcpToolError,
  okResult,
  sanitizeSecretText,
} from '../config.js';
import { withPcdckClient } from '../mcp/pcdck-client.js';
import { parseToolResult } from '../mcp/parse-tool-result.js';
import type { OzonCommandResult } from '../types.js';

export async function callOzonMcpTool(
  command: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<OzonCommandResult> {
  try {
    return await withPcdckClient(async (client) => {
      const result = await client.callTool(toolName, args);
      const parsed = parseToolResult(result);
      if (parsed.isError || isOzonErrorPayload(parsed.data)) {
        return mcpToolError(command, parsed.data);
      }
      return okResult(command, parsed.data);
    });
  } catch (error) {
    return errorResult(command, {
      code: 'OZON_MCP_CALL_FAILED',
      message: sanitizeSecretText(error),
      recoverable: true,
    });
  }
}
