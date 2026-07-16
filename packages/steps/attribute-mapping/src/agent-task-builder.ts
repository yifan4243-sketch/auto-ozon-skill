import type {
  AttributeMappingAgentTaskV1,
  AttributeMappingEvidenceV1,
  CanonicalProductV2,
  CanonicalSkuV2,
  CategoryAttributeV1,
} from '@auto-ozon/contracts';

export const SCRIPT_ATTRIBUTE_IDS = new Set([85, 4383, 4389, 4497, 9048, 11650, 23249]);
const REQUIRED_SCRIPT_ATTRIBUTE_IDS = new Set([85, 4383, 4389, 9048, 11650, 23249]);
export const AGENT_ATTRIBUTE_IDS = new Set([4180, 4191, 4383, 8229, 10096, 23171]);
const SYSTEM_ONLY_ATTRIBUTE_IDS = new Set([21837, 21841, 21845, 22273, 22232, 23536, 8789, 8790, 11254]);

export function shouldProcessAttribute(attribute: CategoryAttributeV1): boolean {
  return true;
}

export function isBusinessRequired(attribute: CategoryAttributeV1): boolean {
  return attribute.required ||
    AGENT_ATTRIBUTE_IDS.has(attribute.id) ||
    REQUIRED_SCRIPT_ATTRIBUTE_IDS.has(attribute.id);
}

export function shouldRequestAgent(attribute: CategoryAttributeV1): boolean {
  return AGENT_ATTRIBUTE_IDS.has(attribute.id) ||
    (attribute.required && !SCRIPT_ATTRIBUTE_IDS.has(attribute.id)) ||
    !SYSTEM_ONLY_ATTRIBUTE_IDS.has(attribute.id);
}

export function buildAgentTask(
  product: CanonicalProductV2,
  sku: CanonicalSkuV2,
  groupId: string,
  attribute: CategoryAttributeV1,
): AttributeMappingAgentTaskV1 {
  const sourceFacts: AttributeMappingEvidenceV1[] = [
    { source: 'canonical_v2', field: 'product.title_zh', value: product.product.title_zh },
    {
      source: 'canonical_v2',
      field: 'source.source_category_path_zh',
      value: product.source.source_category_path_zh.join(' > '),
    },
    ...Object.entries(product.product.attributes).map(([name, value]) => ({
      source: 'canonical_v2' as const,
      field: `product.attributes.${name}`,
      value,
    })),
    ...Object.entries(sku.specs).map(([name, value]) => ({
      source: 'canonical_v2' as const,
      field: `skus.${sku.source_sku_id}.specs.${name}`,
      value,
    })),
  ];
  return {
    source_sku_id: sku.source_sku_id,
    group_id: groupId,
    attribute_id: attribute.id,
    attribute_name: attribute.name,
    required: isBusinessRequired(attribute),
    instruction: instructionFor(attribute),
    source_facts: sourceFacts.filter((evidence) => evidence.value.trim()),
    dictionary_candidates: attribute.values.map((candidate) => ({
      dictionary_value_id: candidate.id,
      value: candidate.value,
    })),
  };
}

function instructionFor(attribute: CategoryAttributeV1): string {
  switch (attribute.id) {
    case 4180:
      return 'Write one natural Russian product name in a single field. It may state the product and supported use cases, but must not contain a brand or a no-brand phrase.';
    case 4191:
      return 'Write a factual Russian description with at least 4 paragraphs and 500 non-whitespace characters.';
    case 4383:
      return 'Estimate net weight in grams from the category and retained 1688 facts. Return one number greater than 3 with low confidence.';
    case 8229:
      return 'Select exactly one best product type from dictionary_candidates. This attribute must be filled.';
    case 10096:
      return 'Select factual colors from dictionary_candidates. If facts cannot decide, select the candidate meaning multicolor.';
    case 23171:
      return 'Write exactly 20 unique Russian hashtags separated by one space; every tag starts with # and multiword tags use underscores.';
    default:
      return attribute.dictionary_id > 0
        ? 'This optional attribute may be filled only when retained 1688 facts support a value. Select only values from dictionary_candidates; otherwise omit it.'
        : 'This optional attribute may be filled only from retained 1688 facts. Do not estimate dimensions, generate media, invent compliance codes, or fill it without evidence.';
  }
}
