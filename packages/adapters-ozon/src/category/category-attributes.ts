import type { PcdckOzonMcpClient } from '../mcp/pcdck-client.js';
import { withPcdckClient } from '../mcp/pcdck-client.js';
import { parseToolResult } from '../mcp/parse-tool-result.js';
import {
  OZON_MCP_TOOLS,
  errorResult,
  executionToolsDisabled,
  extractToolNames,
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
import {
  readCategoryAttributesCache,
  writeCategoryAttributesCache,
  deleteCategoryAttributesCache,
} from './cache.js';
import { ensureExecutionToolAndReadSafety } from '../commands/call.js';

const GET_ATTRS_OP = 'DescriptionCategoryAPI_GetAttributes';
const GET_VALUES_OP = 'DescriptionCategoryAPI_GetAttributeValues';

export async function getCategoryAttributes(
  options: GetCategoryAttributesOptions,
): Promise<OzonCommandResult<CategoryAttributesV1>> {
  const forceRefresh = options.forceRefresh === true;

  // Check cache first (unless --refresh)
  if (!forceRefresh) {
    const cached = await readCategoryAttributesCache(
      options.descriptionCategoryId,
      options.typeId,
    );
    if (cached) {
      return okResult('category.attributes', cached);
    }
  } else {
    // Clear stale cache when forcing refresh
    await deleteCategoryAttributesCache(
      options.descriptionCategoryId,
      options.typeId,
    );
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

      const rawAttributes = attrsParsed.data;

      // Step 2: Identify dictionary attributes
      const attributeList = extractAttributeList(rawAttributes);
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
            message: `Failed to fetch dictionary values for attribute ${attributeId}: ${result.error}`,
            recoverable: true,
            detail: { attributeId, lastValueId: result.lastValueId },
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

      // Step 5: Cache the result
      await writeCategoryAttributesCache(data);

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
        error: `MCP error at last_value_id=${lastValueId}`,
        lastValueId,
      };
    }

    const raw = parsed.data as Record<string, unknown>;
    const batch = normalizeAttributeValues(raw);
    pages.push({ last_value_id: lastValueId, response: raw });

    // Dead-loop prevention: if we get the same IDs back, cursor isn't advancing
    const batchIds = batch.map((v) => v.id);
    const newIds = batchIds.filter((id) => !seenValueIds.has(id));
    if (batch.length > 0 && newIds.length === 0) {
      return {
        ok: false,
        error: `Dictionary cursor stalled at last_value_id=${lastValueId} — no new value IDs returned`,
        lastValueId,
      };
    }
    for (const id of newIds) seenValueIds.add(id);

    allValues.push(...batch);

    hasNext = Boolean(raw?.has_next);
    if (batch.length > 0) {
      const lastId = batch[batch.length - 1].id;
      // Cursor must advance
      if (lastId <= lastValueId && hasNext) {
        return {
          ok: false,
          error: `Dictionary cursor did not advance at last_value_id=${lastValueId}, next=${lastId}, has_next=true`,
          lastValueId,
        };
      }
      lastValueId = lastId;
    }
  }

  return { ok: true, values: allValues, pages };
}

function extractAttributeList(raw: unknown): Record<string, unknown>[] {
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as Record<string, unknown>;
  if (Array.isArray(obj.result)) return obj.result as Record<string, unknown>[];
  if (Array.isArray(obj)) return obj as Record<string, unknown>[];
  return [];
}
