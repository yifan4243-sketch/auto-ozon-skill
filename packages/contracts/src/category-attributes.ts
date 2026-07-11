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

export interface CategoryAttributesV1 {
  schema_version: 1;
  source: 'ozon';
  language: 'ZH_HANS';
  ok: boolean;
  category: {
    description_category_id: number;
    type_id: number;
    description_category_name?: string;
    type_name?: string;
    category_path_zh?: string[];
  };
  attributes: CategoryAttributeV1[];
  raw_response: unknown;
}
