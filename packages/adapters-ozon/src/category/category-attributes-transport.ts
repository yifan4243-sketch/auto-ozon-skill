import { ensureExecutionToolAndReadSafety } from '../commands/call.js';
import {
  OZON_MCP_TOOLS,
  executionToolsDisabled,
  credentialStatus,
  extractToolNames,
  isOzonErrorPayload,
  isRecord,
  normalizeToolError,
  sanitizeSecretText,
} from '../config.js';
import { parseToolResult } from '../mcp/parse-tool-result.js';
import { withPcdckClient, type PcdckOzonMcpClient } from '../mcp/pcdck-client.js';

const GET_ATTRIBUTES = 'DescriptionCategoryAPI_GetAttributes';
const GET_ATTRIBUTE_VALUES = 'DescriptionCategoryAPI_GetAttributeValues';

export interface OzonCategoryAttributesTransport {
  getAttributes(input: {
    descriptionCategoryId: number;
    typeId: number;
  }): Promise<unknown>;
  getAttributeValuesPage(input: {
    descriptionCategoryId: number;
    typeId: number;
    attributeId: number;
    lastValueId: number;
    limit: number;
  }): Promise<unknown>;
}

export class OzonCategoryTransportError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly recoverable: boolean,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'OzonCategoryTransportError';
  }
}

export async function withOzonCategoryAttributesTransport<T>(
  callback: (transport: OzonCategoryAttributesTransport) => Promise<T>,
): Promise<T> {
  if (!credentialStatus().sellerCredentials) {
    throw new OzonCategoryTransportError(
      'OZON_SELLER_CREDENTIALS_REQUIRED',
      'Ozon Seller credentials are required for category attributes.',
      true,
    );
  }
  try {
    return await withPcdckClient(async (client) => {
      await assertTransportReady(client);
      return callback(createTransport(client));
    });
  } catch (error) {
    if (error instanceof OzonCategoryTransportError) throw error;
    throw new OzonCategoryTransportError(
      'OZON_MCP_CALL_FAILED',
      sanitizeSecretText(error),
      true,
    );
  }
}

function createTransport(client: PcdckOzonMcpClient): OzonCategoryAttributesTransport {
  return {
    getAttributes: ({ descriptionCategoryId, typeId }) =>
      callRead(client, GET_ATTRIBUTES, {
        description_category_id: descriptionCategoryId,
        type_id: typeId,
        language: 'ZH_HANS',
      }),
    getAttributeValuesPage: ({
      descriptionCategoryId,
      typeId,
      attributeId,
      lastValueId,
      limit,
    }) =>
      callRead(client, GET_ATTRIBUTE_VALUES, {
        description_category_id: descriptionCategoryId,
        type_id: typeId,
        attribute_id: attributeId,
        language: 'ZH_HANS',
        last_value_id: lastValueId,
        limit,
      }),
  };
}

async function assertTransportReady(client: PcdckOzonMcpClient): Promise<void> {
  const names = extractToolNames(await client.listTools());
  if (!names.includes(OZON_MCP_TOOLS.callMethod)) {
    const result = executionToolsDisabled('category.attributes');
    throw fromCommandError(result.errors[0]);
  }
  for (const operation of [GET_ATTRIBUTES, GET_ATTRIBUTE_VALUES]) {
    const guard = await ensureExecutionToolAndReadSafety(
      client,
      OZON_MCP_TOOLS.callMethod,
      'category.attributes',
      operation,
    );
    if (guard) throw fromCommandError(guard.errors[0]);
  }
}

async function callRead(
  client: PcdckOzonMcpClient,
  operationId: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const parsed = parseToolResult(
    await client.callTool(OZON_MCP_TOOLS.callMethod, {
      operation_id: operationId,
      params,
    }),
  );
  if (parsed.isError || isOzonErrorPayload(parsed.data)) {
    const normalized = normalizeToolError(parsed.data);
    throw new OzonCategoryTransportError(
      normalized.code,
      normalized.message,
      true,
      normalized.detail,
    );
  }
  return unwrapOzonCallResponse(parsed.data);
}

function unwrapOzonCallResponse(value: unknown): unknown {
  if (!isRecord(value) || !Object.hasOwn(value, 'ok')) return value;
  if (value.ok !== true || !Object.hasOwn(value, 'response')) {
    throw new OzonCategoryTransportError(
      'OZON_RESPONSE_INVALID',
      'Malformed ozon-mcp response envelope.',
      true,
    );
  }
  return value.response;
}

function fromCommandError(
  error: { code: string; message: string; recoverable?: boolean; detail?: unknown } | undefined,
): OzonCategoryTransportError {
  return new OzonCategoryTransportError(
    error?.code ?? 'OZON_MCP_CALL_FAILED',
    error?.message ?? 'Ozon category transport is unavailable.',
    error?.recoverable ?? true,
    error?.detail,
  );
}
