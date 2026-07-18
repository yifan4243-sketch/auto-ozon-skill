export type ImageAssetSourceV1 = '1688' | 'generated';

export interface ImageAssetV1 {
  url: string;
  url_sha256: string;
  content_sha256: string;
  byte_size: number;
  media_type: 'image/jpeg' | 'image/png' | 'image/webp';
  width_px: number;
  height_px: number;
  aspect_ratio: number;
  source: ImageAssetSourceV1;
  role: 'primary_candidate' | 'gallery';
  source_sku_ids: string[];
  generation_call_id: string | null;
  text_review: {
    status: 'agent_confirmed' | 'needs_review';
    contains_chinese_text: boolean | null;
    contains_watermark: boolean | null;
    notes: string;
  };
}

export interface SkuImageBundleV1 {
  source_sku_id: string;
  primary_image: string;
  images: string[];
}

export interface ImageGenerationAuditV1 {
  enabled: true;
  provider_id: string;
  model_id: string;
  prompt_version: string;
  call_id: string;
  requested_count: number;
  generated_count: number;
  used_reference_images: boolean;
}

export interface ImageBundleIssueV1 {
  code: string;
  message: string;
  source_sku_ids: string[];
}

export interface ImageBundleV1 {
  schema_version: 1;
  source_offer_id: string;
  status: 'completed' | 'needs_review' | 'blocked';
  assets: ImageAssetV1[];
  sku_images: SkuImageBundleV1[];
  generation: ImageGenerationAuditV1 | null;
  warnings: ImageBundleIssueV1[];
  errors: ImageBundleIssueV1[];
  agent_tasks: Array<{
    execution_owner: 'current_agent';
    content_sha256: string;
    url: string;
    instruction: string;
  }>;
}

export interface ImageReviewAgentInputV1 {
  source_offer_id: string;
  assets: Array<{
    content_sha256: string;
    contains_chinese_text: boolean;
    contains_watermark: boolean;
    notes: string;
  }>;
}

export interface ImageGenerationRequestV1 {
  source_offer_id: string;
  reference_image_urls: string[];
  prompt: string;
  count: number;
}

export interface ImageGenerationResponseV1 {
  provider_id: string;
  model_id: string;
  call_id: string;
  image_urls: string[];
}

export interface ImageGenerationProviderV1 {
  generate(request: ImageGenerationRequestV1, signal?: AbortSignal): Promise<ImageGenerationResponseV1>;
}

export interface ImageGenerationLocalConfigV1 {
  schema_version: 1;
  provider_id: string;
  base_url: string;
  model: string;
  api_key_env: string;
  use_1688_reference_images: boolean;
  image_count: number;
  prompt_version: string;
}
