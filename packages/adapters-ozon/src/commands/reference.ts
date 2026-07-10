import { OZON_MCP_TOOLS } from '../config.js';
import type {
  OzonCommandResult,
  OzonGetErrorCatalogOptions,
  OzonGetExamplesOptions,
  OzonGetRateLimitsOptions,
} from '../types.js';
import { callOzonMcpTool } from './tool-call.js';

export async function ozonGetExamples(
  options: OzonGetExamplesOptions,
): Promise<OzonCommandResult> {
  return callOzonMcpTool('ozon.reference.examples', OZON_MCP_TOOLS.getExamples, {
    operation_id: options.operationId,
  });
}

export async function ozonGetRateLimits(
  options: OzonGetRateLimitsOptions = {},
): Promise<OzonCommandResult> {
  return callOzonMcpTool('ozon.reference.rateLimits', OZON_MCP_TOOLS.getRateLimits, {
    ...(options.operationId === undefined ? {} : { operation_id: options.operationId }),
    ...(options.section === undefined ? {} : { section: options.section }),
  });
}

export async function ozonGetSwaggerMeta(): Promise<OzonCommandResult> {
  return callOzonMcpTool('ozon.reference.swaggerMeta', OZON_MCP_TOOLS.getSwaggerMeta, {});
}

export async function ozonGetErrorCatalog(
  options: OzonGetErrorCatalogOptions = {},
): Promise<OzonCommandResult> {
  return callOzonMcpTool('ozon.reference.errors', OZON_MCP_TOOLS.getErrorCatalog, {
    ...(options.code === undefined ? {} : { code: options.code }),
    ...(options.operationId === undefined ? {} : { operation_id: options.operationId }),
  });
}
