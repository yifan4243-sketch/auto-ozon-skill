import crypto from 'node:crypto';
import type {
  CanonicalProductV2,
  ImageAssetV1,
  ImageBundleIssueV1,
  ImageBundleV1,
  ImageGenerationProviderV1,
} from '@auto-ozon/contracts';

export const DEFAULT_IMAGE_PROMPT_VERSION = 'ozon-product-scenes-v1';
export const DEFAULT_IMAGE_COUNT = 3;

export const DEFAULT_IMAGE_PROMPT = [
  'Create three truthful Ozon marketplace product images using the supplied 1688 product images as visual references.',
  'Keep the exact product shape, color, proportions, materials, included parts, labels, and variant identity.',
  'Image 1 may use a clean relevant lifestyle scene and does not have to use a plain white background.',
  'Image 2 should demonstrate a realistic use scenario. Image 3 should emphasize factual product details.',
  'Do not add logos, brands, certifications, text claims, accessories, people, functions, or package contents that are not visible in the references.',
  'No watermarks, borders, collages, price tags, marketplace UI, or misleading scale.',
].join(' ');

export interface ImagePipelineGenerationOptionsV1 {
  enabled: boolean;
  count?: number;
  prompt?: string;
  use_reference_images?: boolean;
  generated_images_as_primary?: boolean;
}

export interface RunImagePipelineInputV1 {
  product: CanonicalProductV2;
  generation?: ImagePipelineGenerationOptionsV1;
  provider?: ImageGenerationProviderV1;
  signal?: AbortSignal;
}

export async function runImagePipeline(input: RunImagePipelineInputV1): Promise<ImageBundleV1> {
  const result: ImageBundleV1 = {
    schema_version: 1,
    source_offer_id: input.product.source.offer_id,
    status: 'completed',
    assets: [],
    sku_images: [],
    generation: null,
    warnings: [],
    errors: [],
  };
  const sourceBySku = new Map(input.product.skus.map((sku) => [
    sku.source_sku_id,
    validUniqueUrls([sku.image, input.product.product.main_image, ...input.product.product.gallery_images]),
  ]));
  const generation = input.generation;
  let generated: string[] = [];
  if (generation?.enabled) {
    if (!input.provider) {
      result.errors.push(issue('IMAGE_PROVIDER_REQUIRED', 'Image generation was enabled but no injected provider is configured.'));
    } else {
      const count = generation.count ?? DEFAULT_IMAGE_COUNT;
      if (!Number.isSafeInteger(count) || count < 1 || count > 15) {
        result.errors.push(issue('IMAGE_COUNT_INVALID', 'Generated image count must be an integer from 1 to 15.'));
      } else {
        const references = validUniqueUrls([...sourceBySku.values()].flat()).slice(0, 10);
        const response = await input.provider.generate({
          source_offer_id: input.product.source.offer_id,
          reference_image_urls: generation.use_reference_images === false ? [] : references,
          prompt: generation.prompt?.trim() || DEFAULT_IMAGE_PROMPT,
          count,
        }, input.signal);
        generated = validUniqueUrls(response.image_urls).slice(0, count);
        result.generation = {
          enabled: true,
          provider_id: response.provider_id,
          model_id: response.model_id,
          prompt_version: DEFAULT_IMAGE_PROMPT_VERSION,
          call_id: response.call_id,
          requested_count: count,
          generated_count: generated.length,
          used_reference_images: generation.use_reference_images !== false && references.length > 0,
        };
        if (generated.length < count) {
          result.warnings.push(issue('GENERATED_IMAGE_COUNT_SHORT', `Provider returned ${generated.length} valid images; ${count} were requested.`));
        }
      }
    }
  }

  for (const sku of input.product.skus) {
    const sources = sourceBySku.get(sku.source_sku_id) ?? [];
    const generatedFirst = generation?.enabled && generation.generated_images_as_primary !== false;
    const images = validUniqueUrls(generatedFirst ? [...generated, ...sources] : [...sources, ...generated]).slice(0, 15);
    if (images.length === 0) {
      result.errors.push(issue('SKU_IMAGES_MISSING', `SKU ${sku.source_sku_id} has no valid source or generated image.`, [sku.source_sku_id]));
      continue;
    }
    result.sku_images.push({ source_sku_id: sku.source_sku_id, primary_image: images[0]!, images });
  }

  const primaryUrls = new Set(result.sku_images.map((entry) => entry.primary_image));
  const allUrls = validUniqueUrls(result.sku_images.flatMap((entry) => entry.images));
  result.assets = allUrls.map((url): ImageAssetV1 => ({
    url,
    url_sha256: crypto.createHash('sha256').update(url).digest('hex'),
    source: generated.includes(url) ? 'generated' : '1688',
    role: primaryUrls.has(url) ? 'primary_candidate' : 'gallery',
    source_sku_ids: result.sku_images.filter((entry) => entry.images.includes(url)).map((entry) => entry.source_sku_id),
    generation_call_id: generated.includes(url) ? result.generation?.call_id ?? null : null,
  }));
  result.status = result.errors.length > 0 ? 'blocked' : 'completed';
  return result;
}

function validUniqueUrls(values: Array<string | null | undefined>): string[] {
  const output: string[] = [];
  for (const raw of values) {
    const value = raw?.trim();
    if (!value || output.includes(value)) continue;
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol)) continue;
      if (!/\.(?:jpe?g|png|webp)(?:$|[?#])/iu.test(url.href)) continue;
      output.push(value);
    } catch { /* Invalid URLs are rejected deterministically. */ }
  }
  return output;
}

function issue(code: string, message: string, source_sku_ids: string[] = []): ImageBundleIssueV1 {
  return { code, message, source_sku_ids };
}
