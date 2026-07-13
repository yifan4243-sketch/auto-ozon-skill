export const OZON_DRAFT_ATTRIBUTE_IDS = {
  brand: 85,
  name: 4180,
  description: 4191,
  netWeightGrams: 4383,
  originCountry: 4389,
  packagedWeightGrams: 4497,
  productType: 8229,
  pdfName: 8789,
  sellerCode: 9024,
  modelName: 9048,
  color: 10096,
  richContent: 11254,
  factoryPackageCount: 11650,
  hashtags: 23171,
  unifiedUnitCount: 23249,
} as const;

export interface OzonDraftAttributeRuleV1 {
  action: 'fill' | 'omit';
  required_when_available?: boolean;
  default_dictionary_value_id?: number;
}

const A = OZON_DRAFT_ATTRIBUTE_IDS;

/** The single source of truth for V0 attribute policy. */
export const OZON_DRAFT_ATTRIBUTE_RULES: Readonly<Record<number, OzonDraftAttributeRuleV1>> = {
  [A.brand]: { action: 'fill', required_when_available: true, default_dictionary_value_id: 126745801 },
  [A.name]: { action: 'fill', required_when_available: true },
  [A.description]: { action: 'fill', required_when_available: true },
  [A.netWeightGrams]: { action: 'fill', required_when_available: true },
  [A.originCountry]: { action: 'fill', required_when_available: true, default_dictionary_value_id: 90296 },
  [A.packagedWeightGrams]: { action: 'fill', required_when_available: true },
  [A.productType]: { action: 'fill', required_when_available: true },
  [A.pdfName]: { action: 'omit' },
  [A.sellerCode]: { action: 'omit' },
  [A.modelName]: { action: 'fill', required_when_available: true },
  [A.color]: { action: 'fill', required_when_available: true, default_dictionary_value_id: 369939085 },
  [A.richContent]: { action: 'omit' },
  [A.factoryPackageCount]: { action: 'fill', required_when_available: true },
  [A.hashtags]: { action: 'fill', required_when_available: true },
  [A.unifiedUnitCount]: { action: 'fill' },
};

export const OZON_DRAFT_DEFAULT_DICTIONARY_IDS = {
  noBrand: OZON_DRAFT_ATTRIBUTE_RULES[A.brand]!.default_dictionary_value_id!,
  china: OZON_DRAFT_ATTRIBUTE_RULES[A.originCountry]!.default_dictionary_value_id!,
  multicolor: OZON_DRAFT_ATTRIBUTE_RULES[A.color]!.default_dictionary_value_id!,
} as const;

export function getOzonDraftAttributeRule(
  attributeId: number,
): OzonDraftAttributeRuleV1 | undefined {
  return OZON_DRAFT_ATTRIBUTE_RULES[attributeId];
}
