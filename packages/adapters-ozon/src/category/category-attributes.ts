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
} from '../../../contracts/src/category-attributes.js';
import { normalizeCategoryAttributes, normalizeAttributeValues } from './normalizer.js';
import { readCategoryAttributesCache, writeCategoryAttributesCache } from './cache.js';

const GET_ATTRS_OP = 'DescriptionCategoryAPI_GetAttributes';
const GET_VALUES_OP = 'DescriptionCategoryAPI_GetAttributeValues';

export async function getCategoryAttributes(
  options: GetCategoryAttributesOptions,
): Promise<OzonCommandResult<CategoryAttributesV1>> {
  // Check cache first
  const cached = await readCategoryAttributesCache(
    options.descriptionCategoryId,
    options.typeId,
  );
  if (cached) {
    return okResult('category.attributes', cached);
  }

  try {
    return await withPcdckClient(async (client) => {
      // Validate execution tools are available
      const tools = await client.listTools();
      const names = extractToolNames(tools);
      if (!names.includes(OZON_MCP_TOOLS.callMethod)) {
        return executionToolsDisabled('category.attributes') as OzonCommandResult<CategoryAttributesV1>;
      }

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

      const rawAttributes = attrsParsed.data as Record<string, unknown>;

      // Step 2: Identify dictionary attributes
      const attributeList = extractAttributeList(rawAttributes);
      const dictionaryAttrs = attributeList.filter(
        (attr) => Number((attr as Record<string, unknown>).dictionary_id) > 0,
      );

      // Step 3: Fetch dictionary values for each attribute (full pagination)
      const dictionaryValues = new Map<number, CategoryAttributeValueV1[]>();
      for (const attr of dictionaryAttrs) {
        const attrRecord = attr as Record<string, unknown>;
        const attributeId = Number(attrRecord.id);
        const values = await fetchAllAttributeValues(
          client,
          options.descriptionCategoryId,
          options.typeId,
          attributeId,
        );
        dictionaryValues.set(attributeId, values);
      }

      // Step 4: Normalize to CategoryAttributesV1
      const data = normalizeCategoryAttributes(rawAttributes, dictionaryValues, options);

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

async function fetchAllAttributeValues(
  client: PcdckOzonMcpClient,
  descriptionCategoryId: number,
  typeId: number,
  attributeId: number,
): Promise<CategoryAttributeValueV1[]> {
  const allValues: CategoryAttributeValueV1[] = [];
  let lastValueId = 0;
  let hasNext = true;

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
    if (parsed.isError) break;

    const raw = parsed.data as Record<string, unknown>;
    const batch = normalizeAttributeValues(raw);
    allValues.push(...batch);

    hasNext = Boolean(raw?.has_next);
    if (batch.length > 0) {
      lastValueId = Number(batch[batch.length - 1].id);
    }
    if (batch.length < 200) break; // safety belt — should not happen if hasNext is false
  }

  return allValues;
}

function extractAttributeList(raw: unknown): Record<string, unknown>[] {
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as Record<string, unknown>;
  if (Array.isArray(obj.result)) return obj.result as Record<string, unknown>[];
  if (Array.isArray(obj)) return obj as Record<string, unknown>[];
  return [];
}
