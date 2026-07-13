import type { PcdckOzonMcpClient } from '../mcp/pcdck-client.js';
import { withPcdckClient } from '../mcp/pcdck-client.js';
import { parseToolResult } from '../mcp/parse-tool-result.js';
import {
  OZON_MCP_TOOLS,
  errorResult,
  executionToolsDisabled,
  extractToolNames,
  isRecord,
  isOzonErrorPayload,
  mcpToolError,
  okResult,
  sanitizeSecretText,
} from '../config.js';
import type { GetCategoryAttributesOptions, OzonCommandResult } from '../types.js';
import type {
  CategoryAttributesV1,
  CategoryAttributeValueV1,
  DictionaryPageRawV1,
} from '../../../contracts/src/category-attributes.js';
import { normalizeCategoryAttributes, normalizeAttributeValues } from './normalizer.js';
import { ensureExecutionToolAndReadSafety } from '../commands/call.js';

const GET_ATTRS_OP = 'DescriptionCategoryAPI_GetAttributes';
const GET_VALUES_OP = 'DescriptionCategoryAPI_GetAttributeValues';

export async function getCategoryAttributes(
  options: GetCategoryAttributesOptions,
): Promise<OzonCommandResult<CategoryAttributesV1>> {
  if (
    !isPositiveSafeInteger(options.descriptionCategoryId) ||
    !isPositiveSafeInteger(options.typeId)
  ) {
    return errorResult('category.attributes', {
      code: 'BAD_INPUT',
      message: 'descriptionCategoryId and typeId must be positive safe integers.',
      recoverable: false,
    }) as OzonCommandResult<CategoryAttributesV1>;
  }

  try {
    return await withPcdckClient(async (client) => {
      // Validate execution tools are available
      const tools = await client.listTools();
      const names = extractToolNames(tools);
      if (!names.includes(OZON_MCP_TOOLS.callMethod)) {
        return executionToolsDisabled('category.attributes') as OzonCommandResult<CategoryAttributesV1>;
      }

      // Run MCP read-only safety gate for both operations
      const attrSafetyGuard = await ensureExecutionToolAndReadSafety(
        client,
        OZON_MCP_TOOLS.callMethod,
        'category.attributes',
        GET_ATTRS_OP,
      );
      if (attrSafetyGuard) return attrSafetyGuard as OzonCommandResult<CategoryAttributesV1>;

      const valuesSafetyGuard = await ensureExecutionToolAndReadSafety(
        client,
        OZON_MCP_TOOLS.callMethod,
        'category.attributes',
        GET_VALUES_OP,
      );
      if (valuesSafetyGuard) return valuesSafetyGuard as OzonCommandResult<CategoryAttributesV1>;

      // Step 1: Fetch all attributes for the category
      const attrsResult = await client.callTool(OZON_MCP_TOOLS.callMethod, {
        operation_id: GET_ATTRS_OP,
        params: {
          description_category_id: options.descriptionCategoryId,
          type_id: options.typeId,
          language: 'ZH_HANS',
        },
      });
      const attrsParsed = parseToolResult(attrsResult);
      if (attrsParsed.isError || isOzonErrorPayload(attrsParsed.data)) {
        return mcpToolError('category.attributes', attrsParsed.data) as OzonCommandResult<CategoryAttributesV1>;
      }

      const unwrappedAttributes = unwrapOzonCallResponse(attrsParsed.data);
      if (!unwrappedAttributes.ok) {
        return invalidResponseResult(unwrappedAttributes.error);
      }
      const rawAttributes = unwrappedAttributes.data;

      // Step 2: Identify dictionary attributes
      const attributeList = extractAttributeList(rawAttributes);
      if (attributeList === null) {
        return invalidResponseResult(
          `Attributes response for category ${options.descriptionCategoryId}/${options.typeId} does not contain result[].`,
        );
      }
      const dictionaryAttrs = attributeList.filter(
        (attr) => Number((attr as Record<string, unknown>).dictionary_id) > 0,
      );

      // Step 3: Fetch dictionary values for each attribute (full pagination)
      const dictionaryValues = new Map<number, CategoryAttributeValueV1[]>();
      const dictionaryRawResponses: Record<number, DictionaryPageRawV1[]> = {};

      for (const attr of dictionaryAttrs) {
        const attrRecord = attr as Record<string, unknown>;
        const attributeId = Number(attrRecord.id);
        const result = await fetchAllAttributeValues(
          client,
          options.descriptionCategoryId,
          options.typeId,
          attributeId,
        );

        if (!result.ok) {
          return errorResult('category.attributes', {
            code: 'DICTIONARY_FETCH_FAILED',
            message: `Failed to fetch dictionary values for attribute ${attributeId} (category ${options.descriptionCategoryId}/${options.typeId}): ${result.error}`,
            recoverable: true,
            detail: {
              attributeId,
              lastValueId: result.lastValueId,
              descriptionCategoryId: options.descriptionCategoryId,
              typeId: options.typeId,
            },
          }) as OzonCommandResult<CategoryAttributesV1>;
        }

        dictionaryValues.set(attributeId, result.values);
        dictionaryRawResponses[attributeId] = result.pages;
      }

      // Step 4: Normalize to CategoryAttributesV1
      const data = normalizeCategoryAttributes(
        rawAttributes,
        dictionaryValues,
        dictionaryRawResponses,
        options,
      );

      return okResult('category.attributes', data);
    });
  } catch (error) {
    return errorResult('category.attributes', {
      code: 'OZON_MCP_CALL_FAILED',
      message: sanitizeSecretText(error),
      recoverable: true,
    }) as OzonCommandResult<CategoryAttributesV1>;
  }
}

interface FetchValuesOk {
  ok: true;
  values: CategoryAttributeValueV1[];
  pages: DictionaryPageRawV1[];
}

interface FetchValuesErr {
  ok: false;
  error: string;
  lastValueId: number;
}

type FetchValuesResult = FetchValuesOk | FetchValuesErr;

async function fetchAllAttributeValues(
  client: PcdckOzonMcpClient,
  descriptionCategoryId: number,
  typeId: number,
  attributeId: number,
): Promise<FetchValuesResult> {
  const allValues: CategoryAttributeValueV1[] = [];
  const pages: DictionaryPageRawV1[] = [];
  let lastValueId = 0;
  let hasNext = true;
  const seenValueIds = new Set<number>();

  while (hasNext) {
    const result = await client.callTool(OZON_MCP_TOOLS.callMethod, {
      operation_id: GET_VALUES_OP,
      params: {
        description_category_id: descriptionCategoryId,
        type_id: typeId,
        attribute_id: attributeId,
        language: 'ZH_HANS',
        last_value_id: lastValueId,
        limit: 200,
      },
    });
    const parsed = parseToolResult(result);

    // Dictionary fetch failure is fatal — do not return incomplete results
    if (parsed.isError || isOzonErrorPayload(parsed.data)) {
      return {
        ok: false,
        error: `MCP error at attribute_id=${attributeId}, last_value_id=${lastValueId}, category=${descriptionCategoryId}/${typeId}`,
        lastValueId,
      };
    }

    const unwrapped = unwrapOzonCallResponse(parsed.data);
    if (!unwrapped.ok || !isRecord(unwrapped.data)) {
      return {
        ok: false,
        error: unwrapped.ok
          ? `Invalid dictionary response at attribute_id=${attributeId}, last_value_id=${lastValueId}, category=${descriptionCategoryId}/${typeId}`
          : `${unwrapped.error} at attribute_id=${attributeId}, last_value_id=${lastValueId}, category=${descriptionCategoryId}/${typeId}`,
        lastValueId,
      };
    }
    const raw = unwrapped.data;
    if (!Array.isArray(raw.result) || typeof raw.has_next !== 'boolean') {
      return {
        ok: false,
        error: `Dictionary response must contain result[] and boolean has_next at attribute_id=${attributeId}, last_value_id=${lastValueId}, category=${descriptionCategoryId}/${typeId}`,
        lastValueId,
      };
    }
    const batch = normalizeAttributeValues(raw);
    pages.push({ last_value_id: lastValueId, response: raw });

    const newValues: CategoryAttributeValueV1[] = [];
    for (const value of batch) {
      if (!isPositiveSafeInteger(value.id)) {
        return {
          ok: false,
          error: `Dictionary response contains an invalid value ID at attribute_id=${attributeId}, last_value_id=${lastValueId}, category=${descriptionCategoryId}/${typeId}`,
          lastValueId,
        };
      }
      if (seenValueIds.has(value.id)) continue;
      seenValueIds.add(value.id);
      newValues.push(value);
    }

    // Dead-loop prevention: if we get only IDs seen on earlier pages, the cursor stalled.
    if (batch.length > 0 && newValues.length === 0) {
      return {
        ok: false,
        error: `Dictionary cursor stalled at attribute_id=${attributeId}, last_value_id=${lastValueId} — no new value IDs returned`,
        lastValueId,
      };
    }
    allValues.push(...newValues);

    hasNext = Boolean(raw?.has_next);

    // Empty page with has_next=true → would loop forever
    if (hasNext && batch.length === 0) {
      return {
        ok: false,
        error: `Empty dictionary page with has_next=true at attribute_id=${attributeId}, last_value_id=${lastValueId}, category=${descriptionCategoryId}/${typeId}`,
        lastValueId,
      };
    }

    if (batch.length > 0) {
      const lastId = batch[batch.length - 1].id;
      // Cursor must advance
      if (lastId <= lastValueId && hasNext) {
        return {
          ok: false,
          error: `Dictionary cursor did not advance at attribute_id=${attributeId}, last_value_id=${lastValueId}, next=${lastId}, has_next=true`,
          lastValueId,
        };
      }
      lastValueId = lastId;
    }
  }

  return { ok: true, values: allValues, pages };
}

function extractAttributeList(raw: unknown): Record<string, unknown>[] | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (Array.isArray(obj.result)) return obj.result as Record<string, unknown>[];
  if (Array.isArray(obj)) return obj as Record<string, unknown>[];
  return null;
}

type UnwrappedOzonResponse =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

function unwrapOzonCallResponse(value: unknown): UnwrappedOzonResponse {
  if (!isRecord(value) || !Object.hasOwn(value, 'ok')) {
    return { ok: true, data: value };
  }
  if (value.ok !== true || !Object.hasOwn(value, 'response')) {
    return { ok: false, error: 'Malformed ozon-mcp response envelope.' };
  }
  return { ok: true, data: value.response };
}

function invalidResponseResult(
  message: string,
): OzonCommandResult<CategoryAttributesV1> {
  return errorResult('category.attributes', {
    code: 'OZON_RESPONSE_INVALID',
    message,
    recoverable: true,
  }) as OzonCommandResult<CategoryAttributesV1>;
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
