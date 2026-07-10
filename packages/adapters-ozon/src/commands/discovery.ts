import { OZON_MCP_TOOLS } from '../config.js';
import type {
  OzonCommandResult,
  OzonGetRelatedMethodsOptions,
  OzonGetSectionOptions,
} from '../types.js';
import { callOzonMcpTool } from './tool-call.js';

export async function ozonListSections(): Promise<OzonCommandResult> {
  return callOzonMcpTool('ozon.sections.list', OZON_MCP_TOOLS.listSections, {});
}

export async function ozonGetSection(
  options: OzonGetSectionOptions,
): Promise<OzonCommandResult> {
  return callOzonMcpTool('ozon.sections.get', OZON_MCP_TOOLS.getSection, {
    query: options.query,
  });
}

export async function ozonGetRelatedMethods(
  options: OzonGetRelatedMethodsOptions,
): Promise<OzonCommandResult> {
  return callOzonMcpTool('ozon.methods.related', OZON_MCP_TOOLS.getRelatedMethods, {
    operation_id: options.operationId,
    ...(options.maxHops === undefined ? {} : { max_hops: options.maxHops }),
  });
}
