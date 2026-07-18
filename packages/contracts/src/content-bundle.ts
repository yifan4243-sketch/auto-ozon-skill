import type { AttributeMappingConfidenceV1 } from './attribute-mapping.js';

export interface ContentEvidenceRefV1 {
  json_pointer: string;
  value: string;
}

export interface ContentClaimV1 {
  claim_text: string;
  evidence_refs: ContentEvidenceRefV1[];
}

export interface ContentSkuV1 {
  source_sku_id: string;
  title_ru: string;
  description_ru: string;
  hashtags_ru: string[];
  confidence: AttributeMappingConfidenceV1;
  evidence_refs: ContentEvidenceRefV1[];
  claims: ContentClaimV1[];
}

export interface ContentBundleV1 {
  schema_version: 1;
  source_offer_id: string;
  status: 'completed' | 'needs_review' | 'blocked';
  sku_content: ContentSkuV1[];
  errors: Array<{ code: string; source_sku_id: string; message: string }>;
}
