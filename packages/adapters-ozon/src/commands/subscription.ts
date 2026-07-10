import { OZON_MCP_TOOLS } from '../config.js';
import type {
  OzonCommandResult,
  OzonGetSubscriptionStatusOptions,
  OzonListMethodsForSubscriptionOptions,
} from '../types.js';
import { callOzonMcpTool } from './tool-call.js';

export async function ozonGetSubscriptionStatus(
  options: OzonGetSubscriptionStatusOptions = {},
): Promise<OzonCommandResult> {
  return callOzonMcpTool(
    'ozon.subscription.status',
    OZON_MCP_TOOLS.getSubscriptionStatus,
    options.refresh === undefined ? {} : { refresh: options.refresh },
  );
}

export async function ozonListMethodsForSubscription(
  options: OzonListMethodsForSubscriptionOptions,
): Promise<OzonCommandResult> {
  return callOzonMcpTool(
    'ozon.subscription.methods',
    OZON_MCP_TOOLS.listMethodsForSubscription,
    { tier: options.tier },
  );
}
