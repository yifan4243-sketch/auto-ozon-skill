import { OZON_MCP_TOOLS } from '../config.js';
import type {
  OzonCommandResult,
  OzonDescribeMethodOptions,
  OzonSearchMethodsOptions,
} from '../types.js';
import { callOzonMcpTool } from './tool-call.js';

export async function ozonSearchMethods(
  options: OzonSearchMethodsOptions,
): Promise<OzonCommandResult> {
  return callOzonMcpTool('ozon.methods.search', OZON_MCP_TOOLS.searchMethods, {
    query: options.query,
    ...(options.section === undefined ? {} : { section: options.section }),
    ...(options.api === undefined ? {} : { api: options.api }),
    ...(options.safety === undefined ? {} : { safety: options.safety }),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  });
}

export async function ozonDescribeMethod(
  options: OzonDescribeMethodOptions,
): Promise<OzonCommandResult> {
  return callOzonMcpTool('ozon.methods.describe', OZON_MCP_TOOLS.describeMethod, {
    ...(options.operationId === undefined ? {} : { operation_id: options.operationId }),
    ...(options.path === undefined ? {} : { path: options.path }),
    ...(options.httpMethod === undefined ? {} : { http_method: options.httpMethod }),
  });
}
