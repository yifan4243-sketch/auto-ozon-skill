import { describe, expect, it, vi } from 'vitest';
import type { CanonicalProductV2 } from '../../../packages/contracts/src/index.js';
import { DEFAULT_IMAGE_COUNT, runImagePipeline } from '../../../packages/image-pipeline/src/index.js';

describe('image pipeline', () => {
  it('uses source images without requiring a generation provider', async () => {
    const result = await runImagePipeline({ product: product() });
    expect(result).toMatchObject({
      status: 'completed', generation: null,
      sku_images: [{ source_sku_id: 'sku-1', primary_image: 'https://img.example.com/sku.jpg' }],
    });
    expect(result.assets.every((asset) => asset.source === '1688')).toBe(true);
  });

  it('requests three referenced images by default and records provider provenance', async () => {
    const generate = vi.fn(async () => ({
      provider_id: 'injected-test', model_id: 'image-model', call_id: 'call-1',
      image_urls: ['https://generated.example.com/1.png', 'https://generated.example.com/2.png', 'https://generated.example.com/3.png'],
    }));
    const result = await runImagePipeline({ product: product(), generation: { enabled: true }, provider: { generate } });
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ count: DEFAULT_IMAGE_COUNT, reference_image_urls: expect.arrayContaining(['https://img.example.com/sku.jpg']) }), undefined);
    expect(result).toMatchObject({ status: 'completed', generation: { call_id: 'call-1', requested_count: 3, generated_count: 3, used_reference_images: true } });
    expect(result.sku_images[0]!.primary_image).toBe('https://generated.example.com/1.png');
  });

  it('blocks only when generation is explicitly enabled without a provider', async () => {
    const result = await runImagePipeline({ product: product(), generation: { enabled: true } });
    expect(result).toMatchObject({ status: 'blocked', errors: [{ code: 'IMAGE_PROVIDER_REQUIRED' }] });
  });
});

function product(): CanonicalProductV2 {
  return {
    schema_version: 2,
    source: { platform: '1688', offer_id: '1', offer_url: 'https://detail.1688.com/offer/1.html', collected_at: new Date(0).toISOString(), collection_method: 'offers', detail_url: null, source_category_path_zh: [], discovery_context: { search_term: null, seed_offer_id: null } },
    product: { title_zh: '杯子', main_image: 'https://img.example.com/main.jpg', gallery_images: ['https://img.example.com/gallery.webp'], attributes: {}, price_tiers: [], sku_options: [] },
    skus: [{ source_sku_id: 'sku-1', raw_spec_text: '红色', specs: { 颜色: '红色' }, unparsed_spec_segments: [], price_cny: 20, multi_price_cny: null, image: 'https://img.example.com/sku.jpg', package: { length_cm: 10, width_cm: 10, height_cm: 10, raw_weight: 100, weight_unit: 'g', source: '1688', matched_by: 'sku_id' } }],
    sku_analysis: { has_source_skus: true, is_multi_sku: false, sku_count: 1, common_fields: {}, varying_fields: [], variant_dimensions: [], missing_fields: [], duplicate_spec_combinations: [], warnings: [] },
    validation: { status: 'valid', warnings: [], errors: [] },
  };
}
