import type { ErrorObject, WarningObject } from '../../contracts/src/command-result.js';
import type { OzonCredentialsStatus, OzonToolAvailability } from './types.js';

export const OZON_MCP_TOOLS = {
  callMethod: 'ozon_call_method',
  fetchAll: 'ozon_fetch_all',
  describeMethod: 'ozon_describe_method',
  searchMethods: 'ozon_search_methods',
  listSections: 'ozon_list_sections',
  getSection: 'ozon_get_section',
  listWorkflows: 'ozon_list_workflows',
  getWorkflow: 'ozon_get_workflow',
  getRelatedMethods: 'ozon_get_related_methods',
  getExamples: 'ozon_get_examples',
  getRateLimits: 'ozon_get_rate_limits',
  getSubscriptionStatus: 'ozon_get_subscription_status',
  listMethodsForSubscription: 'ozon_list_methods_for_subscription',
  getSwaggerMeta: 'ozon_get_swagger_meta',
  getErrorCatalog: 'ozon_get_error_catalog',
} as const;

export const DISCOVERY_TOOLS = [
  OZON_MCP_TOOLS.searchMethods,
  OZON_MCP_TOOLS.describeMethod,
  OZON_MCP_TOOLS.listSections,
  OZON_MCP_TOOLS.getSection,
  OZON_MCP_TOOLS.getRelatedMethods,
  OZON_MCP_TOOLS.listWorkflows,
  OZON_MCP_TOOLS.getWorkflow,
] as const;

export const REFERENCE_TOOLS = [
  OZON_MCP_TOOLS.getExamples,
  OZON_MCP_TOOLS.getRateLimits,
  OZON_MCP_TOOLS.listMethodsForSubscription,
  OZON_MCP_TOOLS.getSwaggerMeta,
  OZON_MCP_TOOLS.getErrorCatalog,
] as const;

export const EXECUTION_TOOLS = [
  OZON_MCP_TOOLS.callMethod,
  OZON_MCP_TOOLS.fetchAll,
] as const;

export const CREDENTIAL_TOOLS = [OZON_MCP_TOOLS.getSubscriptionStatus] as const;

// PCDCK/ozon-mcp always registers discovery, workflow, graph, and reference tools.
// Execution tools are registered only when Seller or Performance credentials exist;
// subscription status is registered only when Seller credentials exist.
export const FULL_BRIDGE_CORE_TOOLS = [
  ...DISCOVERY_TOOLS,
  ...REFERENCE_TOOLS,
] as const;

export const SECRET_ENV_KEYS = [
  'OZON_CLIENT_ID',
  'OZON_API_KEY',
  'OZON_PERFORMANCE_CLIENT_ID',
  'OZON_PERFORMANCE_CLIENT_SECRET',
] as const;

export const SUBMODULE_NEXT_ACTIONS = [
  'git submodule update --init --recursive',
  'cd vendor/ozon-mcp',
  'uv sync',
  'uv run ozon-mcp --help',
];

export const UV_NEXT_ACTIONS = [
  'Install uv: https://docs.astral.sh/uv/getting-started/installation/',
  'Run git submodule update --init --recursive.',
  'Run cd vendor/ozon-mcp && uv sync.',
];

export const EXECUTION_TOOLS_NEXT_ACTIONS = [
  'Configure OZON_CLIENT_ID and OZON_API_KEY.',
  'Run auto-ozon ozon doctor --json --pretty.',
];

export const WRITE_BLOCKED_NEXT_ACTIONS = [
  'Use method search/describe/examples to inspect the write method.',
  'Keep write operations behind a separate preview and explicit confirmation flow.',
];

export function credentialStatus(env = process.env): OzonCredentialsStatus {
  return {
    sellerCredentials: Boolean(env.OZON_CLIENT_ID && env.OZON_API_KEY),
    performanceCredentials: Boolean(
      env.OZON_PERFORMANCE_CLIENT_ID && env.OZON_PERFORMANCE_CLIENT_SECRET,
    ),
  };
}

export function toolAvailability(
  toolNames: Iterable<string>,
  required: readonly string[],
): OzonToolAvailability {
  const names = new Set(toolNames);
  const missing = required.filter((name) => !names.has(name));
  return { available: missing.length === 0, missing };
}

export function extractToolNames(result: unknown): string[] {
  if (!isRecord(result)) return [];
  const tools = result.tools;
  if (!Array.isArray(tools)) return [];
  return tools
    .map((tool) => (isRecord(tool) && typeof tool.name === 'string' ? tool.name : null))
    .filter((name): name is string => name !== null);
}

export function sanitizeSecretText(value: unknown): string {
  let text = value instanceof Error ? value.message : String(value);
  for (const key of SECRET_ENV_KEYS) {
    const secret = process.env[key];
    if (secret) text = text.split(secret).join(`[${key}_REDACTED]`);
  }
  return text;
}

export function sanitizeUnknown(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeSecretText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeUnknown(item));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, sanitizeUnknown(entry)]),
  );
}

export function okResult<T>(
  command: string,
  data: T,
  warnings: WarningObject[] = [],
  nextActions: string[] = [],
) {
  return {
    ok: true,
    command,
    data,
    warnings,
    errors: [],
    nextActions,
  };
}

export function errorResult<T = unknown>(
  command: string,
  error: ErrorObject,
  nextActions: string[] = [],
  warnings: WarningObject[] = [],
  data?: T,
) {
  return {
    ok: false,
    command,
    ...(data === undefined ? {} : { data }),
    warnings,
    errors: [error],
    nextActions,
  };
}

export function mcpToolError(command: string, parsedData: unknown) {
  const info = normalizeToolError(parsedData);
  return errorResult(command, {
    code: info.code,
    message: info.message,
    detail: info.detail,
    recoverable: true,
  });
}

export function executionToolsDisabled(command: string) {
  return errorResult(
    command,
    {
      code: 'OZON_EXECUTION_TOOLS_DISABLED',
      message: 'Ozon execution tools are disabled. Configure OZON_CLIENT_ID and OZON_API_KEY.',
      recoverable: true,
    },
    EXECUTION_TOOLS_NEXT_ACTIONS,
  );
}

export function writeBlocked(command: string) {
  return errorResult(
    command,
    {
      code: 'OZON_WRITE_BLOCKED',
      message:
        'This Ozon method modifies data and is blocked by the local read-only bridge policy.',
      recoverable: true,
    },
    WRITE_BLOCKED_NEXT_ACTIONS,
  );
}

export function extractSafety(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (typeof value.safety === 'string') return value.safety;
  if (isRecord(value.method) && typeof value.method.safety === 'string') return value.method.safety;
  if (isRecord(value.data) && typeof value.data.safety === 'string') return value.data.safety;
  return null;
}

export function isOzonErrorPayload(value: unknown): boolean {
  return (
    isRecord(value) &&
    (typeof value.error_type === 'string' ||
      (typeof value.error === 'string' && typeof value.message === 'string'))
  );
}

export function normalizeToolError(data: unknown): {
  code: string;
  message: string;
  detail?: unknown;
} {
  if (isRecord(data)) {
    const code =
      firstString(data.code, data.error_code, data.error_type, data.error, data.type, data.status) ??
      'OZON_MCP_TOOL_ERROR';
    const message =
      firstString(data.message, data.error, data.detail) ?? 'Ozon MCP tool returned an error.';
    return {
      code: sanitizeSecretText(code).toUpperCase(),
      message: sanitizeSecretText(message),
      detail: sanitizeUnknown(data),
    };
  }
  return {
    code: 'OZON_MCP_TOOL_ERROR',
    message: sanitizeSecretText(data ?? 'Ozon MCP tool returned an error.'),
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}
