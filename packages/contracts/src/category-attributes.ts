export interface CategoryAttributeValueV1 {
  id: number;
  value: string;
  info?: string;
  picture?: string;
}

export interface CategoryAttributeV1 {
  id: number;
  name: string;
  description: string;
  type: string;
  required: boolean;
  is_collection: boolean;
  is_aspect: boolean;
  dictionary_id: number;
  group_id: number;
  group_name: string;
  category_dependent: boolean;
  values: CategoryAttributeValueV1[];
}

export interface DictionaryPageRawV1 {
  last_value_id: number;
  response: unknown;
}

export interface CategoryAttributesV1 {
  schema_version: 1;
  source: 'ozon';
  language: 'ZH_HANS';
  ok: boolean;
  fetched_at: string;
  category: {
    description_category_id: number;
    type_id: number;
    description_category_name?: string;
    type_name?: string;
    category_path_zh?: string[];
  };
  attributes: CategoryAttributeV1[];
  raw_response: unknown;
  dictionary_raw_responses: Record<number, DictionaryPageRawV1[]>;
}

export interface CategoryAttributesGroupV1 {
  group_ids: string[];
  category: {
    description_category_id: number;
    description_category_name: string;
    type_id: number;
    type_name: string;
    category_path_zh: string[];
  };
  attributes_schema: CategoryAttributesV1;
}

export interface CategoryAttributesCacheEnvelopeV1 {
  schema_version: 1;
  namespace: 'category-attributes';
  description_category_id: number;
  type_id: number;
  language: 'ZH_HANS';
  fetched_at: string;
  source_snapshot_sha256: string;
  payload_sha256: string;
  payload: CategoryAttributesV1;
}
