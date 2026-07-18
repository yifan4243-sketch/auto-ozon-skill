import crypto from 'node:crypto';
import type {
  CanonicalProductV2,
  ImageBundleIssueV1,
  ImageBundleV1,
  ImageGenerationProviderV1,
  ImageReviewAgentInputV1,
} from '@auto-ozon/contracts';
import {
  DEFAULT_IMAGE_CONCURRENCY,
  DEFAULT_IMAGE_TOTAL_TIMEOUT_MS,
  inspectRemoteImage,
  type ImageFetchPolicyV1,
  type ImageHostResolverV1,
  type InspectedRemoteImageV1,
} from './remote-image.js';

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
  agent_review?: ImageReviewAgentInputV1;
  fetch?: typeof fetch;
  resolver?: ImageHostResolverV1;
  network?: ImageFetchPolicyV1;
  signal?: AbortSignal;
}
const MIN_IMAGE_SIDE_PX = 200;
type ImageInspectionResult =
  | { url: string; ok: true; inspected: InspectedRemoteImageV1 }
  | { url: string; ok: false; error: unknown };

export async function runImagePipeline(input: RunImagePipelineInputV1): Promise<ImageBundleV1> {
  const totalController = new AbortController();
  const forwardAbort = () => totalController.abort(input.signal?.reason);
  if (input.signal?.aborted) forwardAbort();
  else input.signal?.addEventListener('abort', forwardAbort, { once: true });
  const totalTimeout = setTimeout(
    () => totalController.abort(new Error('IMAGE_PIPELINE_TOTAL_TIMEOUT')),
    positiveInteger(input.network?.total_timeout_ms, DEFAULT_IMAGE_TOTAL_TIMEOUT_MS),
  );
  const result: ImageBundleV1 = {
    schema_version: 1,
    source_offer_id: input.product.source.offer_id,
    status: 'completed',
    assets: [],
    sku_images: [],
    generation: null,
    warnings: [],
    errors: [],
    agent_tasks: [],
  };
  if (input.agent_review && input.agent_review.source_offer_id !== input.product.source.offer_id) {
    result.errors.push(issue('IMAGE_REVIEW_OFFER_MISMATCH', 'Image review belongs to another source offer.'));
  }
  const reviewedHashes = new Set<string>();
  for (const review of input.agent_review?.assets ?? []) {
    if (!/^[a-f0-9]{64}$/u.test(review.content_sha256)
      || typeof review.contains_chinese_text !== 'boolean'
      || typeof review.contains_watermark !== 'boolean'
      || typeof review.notes !== 'string') {
      result.errors.push(issue('IMAGE_REVIEW_INVALID', 'Image review must contain a lowercase SHA-256, two boolean decisions, and notes.'));
      continue;
    }
    if (reviewedHashes.has(review.content_sha256)) {
      result.errors.push(issue('IMAGE_REVIEW_DUPLICATE', `Image review contains duplicate content hash ${review.content_sha256}.`));
    }
    reviewedHashes.add(review.content_sha256);
  }
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
        try {
          const response = await input.provider.generate({
            source_offer_id: input.product.source.offer_id,
            reference_image_urls: generation.use_reference_images === false ? [] : references,
            prompt: generation.prompt?.trim() || DEFAULT_IMAGE_PROMPT,
            count,
          }, totalController.signal);
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
          if (generated.length < count) result.warnings.push(issue('GENERATED_IMAGE_COUNT_SHORT', `Provider returned ${generated.length} valid image URLs; ${count} were requested.`));
        } catch (error) {
          result.errors.push(issue(
            totalController.signal.aborted ? 'IMAGE_PIPELINE_TOTAL_TIMEOUT' : 'IMAGE_GENERATION_FAILED',
            error instanceof Error ? error.message : String(error),
          ));
        }
      }
    }
  }

  const requestedBySku = new Map(input.product.skus.map((sku) => {
    const sources = sourceBySku.get(sku.source_sku_id) ?? [];
    const generatedFirst = generation?.enabled && generation.generated_images_as_primary !== false;
    return [sku.source_sku_id, validUniqueUrls(generatedFirst ? [...generated, ...sources] : [...sources, ...generated]).slice(0, 15)];
  }));
  // Inspect and retain every distinct 1688 source image even when Ozon's
  // per-SKU gallery limit means only a subset can enter sku_images[].
  const allUrls = validUniqueUrls([...sourceBySku.values()].flat().concat(generated));
  const canonicalUrl = new Map<string, string>();
  const inspectedByUrl = new Map<string, InspectedRemoteImageV1>();
  const firstUrlByContent = new Map<string, string>();
  const inspections = await mapConcurrent<string, ImageInspectionResult>(allUrls, positiveInteger(input.network?.concurrency, DEFAULT_IMAGE_CONCURRENCY), async (url) => {
    try {
      return { url, ok: true, inspected: await inspectRemoteImage(url, input.fetch ?? fetch, input.resolver, input.network, totalController.signal) };
    } catch (error) {
      return { url, ok: false, error };
    }
  });
  for (const inspection of inspections) {
    const { url } = inspection;
    const sourceSkuIds = sourceSkuIdsForUrl(input.product, sourceBySku, requestedBySku, url);
    if (inspection.ok) {
      const inspected = inspection.inspected;
      const existing = firstUrlByContent.get(inspected.contentSha256);
      if (existing) {
        canonicalUrl.set(url, existing);
        result.warnings.push(issue('DUPLICATE_IMAGE_CONTENT', `Image ${url} duplicates already retained image ${existing}.`, sourceSkuIds));
        continue;
      }
      firstUrlByContent.set(inspected.contentSha256, url);
      canonicalUrl.set(url, url);
      inspectedByUrl.set(url, inspected);
      if (inspected.width < MIN_IMAGE_SIDE_PX || inspected.height < MIN_IMAGE_SIDE_PX) {
        result.errors.push(issue('IMAGE_DIMENSIONS_TOO_SMALL', `Image ${url} is ${inspected.width}x${inspected.height}; both sides must be at least ${MIN_IMAGE_SIDE_PX}px.`, sourceSkuIds));
      }
      const ratio = inspected.width / inspected.height;
      if (ratio < 0.5 || ratio > 2) result.warnings.push(issue('IMAGE_ASPECT_RATIO_EXTREME', `Image ${url} has aspect ratio ${ratio.toFixed(3)}.`, sourceSkuIds));
    } else {
      const error = inspection.error;
      result.errors.push(issue(
        totalController.signal.aborted ? 'IMAGE_PIPELINE_TOTAL_TIMEOUT' : 'IMAGE_INSPECTION_FAILED',
        `${url}: ${error instanceof Error ? error.message : String(error)}`,
        sourceSkuIds,
      ));
    }
  }

  const reviewByHash = new Map(input.agent_review?.assets.map((review) => [review.content_sha256, review]) ?? []);
  for (const [url, inspected] of inspectedByUrl) {
    const sourceSkuIds = input.product.skus.filter((sku) =>
      sourceBySku.get(sku.source_sku_id)?.some((candidate) => canonicalUrl.get(candidate) === url)
      || requestedBySku.get(sku.source_sku_id)?.some((candidate) => canonicalUrl.get(candidate) === url),
    ).map((sku) => sku.source_sku_id);
    const review = reviewByHash.get(inspected.contentSha256);
    if (review?.contains_chinese_text) result.errors.push(issue('IMAGE_CHINESE_TEXT_DETECTED', `Chinese text was detected in image ${url}.`, sourceSkuIds));
    if (review?.contains_watermark) result.errors.push(issue('IMAGE_WATERMARK_DETECTED', `A watermark was detected in image ${url}.`, sourceSkuIds));
    if (!review) {
      result.agent_tasks.push({
        execution_owner: 'current_agent',
        content_sha256: inspected.contentSha256,
        url,
        instruction: 'Visually inspect the decoded image. Report whether visible Chinese text or any watermark is present; do not infer product facts.',
      });
    }
    result.assets.push({
      url,
      url_sha256: crypto.createHash('sha256').update(url).digest('hex'),
      content_sha256: inspected.contentSha256,
      byte_size: inspected.bytes.byteLength,
      media_type: inspected.mediaType,
      width_px: inspected.width,
      height_px: inspected.height,
      aspect_ratio: Math.round(inspected.width / inspected.height * 10_000) / 10_000,
      source: generated.includes(url) ? 'generated' : '1688',
      role: 'gallery',
      source_sku_ids: sourceSkuIds,
      generation_call_id: generated.includes(url) ? result.generation?.call_id ?? null : null,
      text_review: review
        ? { status: 'agent_confirmed', contains_chinese_text: review.contains_chinese_text, contains_watermark: review.contains_watermark, notes: review.notes }
        : { status: 'needs_review', contains_chinese_text: null, contains_watermark: null, notes: '' },
    });
  }
  for (const review of input.agent_review?.assets ?? []) {
    if (!result.assets.some((asset) => asset.content_sha256 === review.content_sha256)) {
      result.errors.push(issue('IMAGE_REVIEW_UNKNOWN_ASSET', `Image review references unknown content hash ${review.content_sha256}.`));
    }
  }

  for (const sku of input.product.skus) {
    const images = [...new Set((requestedBySku.get(sku.source_sku_id) ?? [])
      .map((url) => canonicalUrl.get(url))
      .filter((url): url is string => Boolean(url && inspectedByUrl.has(url))))].slice(0, 15);
    if (images.length === 0) {
      result.errors.push(issue('SKU_IMAGES_MISSING', `SKU ${sku.source_sku_id} has no decoded and validated image.`, [sku.source_sku_id]));
      continue;
    }
    result.sku_images.push({ source_sku_id: sku.source_sku_id, primary_image: images[0]!, images });
    const primary = result.assets.find((asset) => asset.url === images[0]);
    if (primary) primary.role = 'primary_candidate';
  }
  result.status = result.errors.length > 0 ? 'blocked' : result.agent_tasks.length > 0 ? 'needs_review' : 'completed';
  clearTimeout(totalTimeout);
  input.signal?.removeEventListener('abort', forwardAbort);
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

function sourceSkuIdsForUrl(
  product: CanonicalProductV2,
  sourceBySku: ReadonlyMap<string, string[]>,
  requestedBySku: ReadonlyMap<string, string[]>,
  url: string,
): string[] {
  return product.skus
    .filter((sku) => sourceBySku.get(sku.source_sku_id)?.includes(url) || requestedBySku.get(sku.source_sku_id)?.includes(url))
    .map((sku) => sku.source_sku_id);
}

async function mapConcurrent<T, R>(values: readonly T[], concurrency: number, worker: (value: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await worker(values[index]!);
    }
  }));
  return output;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? value! : fallback;
}
