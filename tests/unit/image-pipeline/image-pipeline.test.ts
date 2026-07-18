import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { CanonicalProductV2, ImageReviewAgentInputV1 } from '../../../packages/contracts/src/index.js';
import {
  assertRemoteUrlSafe,
  DEFAULT_IMAGE_COUNT,
  inspectRemoteImage,
  isForbiddenAddress,
  runImagePipeline,
} from '../../../packages/image-pipeline/src/index.js';

const PUBLIC_IP = '93.184.216.34';
const resolver = vi.fn(async () => [PUBLIC_IP]);

describe('image pipeline', () => {
  it('uses source images with injected offline transport and completed Agent review', async () => {
    const urls = sourceUrls();
    const bodies = bodiesFor(urls);
    const result = await runImagePipeline({
      product: product(urls),
      fetch: fetchFrom(bodies),
      resolver,
      agent_review: reviews(bodies),
    });
    expect(result).toMatchObject({
      status: 'completed', generation: null,
      sku_images: [{ source_sku_id: 'sku-1', primary_image: urls[0] }],
    });
    expect(result.assets.every((asset) => asset.source === '1688')).toBe(true);
  });

  it('requests three referenced images by default and records provider provenance', async () => {
    const urls = sourceUrls();
    const generated = ['https://generated.example/1.png', 'https://generated.example/2.png', 'https://generated.example/3.png'];
    const bodies = bodiesFor([...urls, ...generated]);
    const generate = vi.fn(async () => ({
      provider_id: 'injected-test', model_id: 'image-model', call_id: 'call-1', image_urls: generated,
    }));
    const result = await runImagePipeline({
      product: product(urls), generation: { enabled: true }, provider: { generate },
      fetch: fetchFrom(bodies), resolver, agent_review: reviews(bodies),
    });
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      count: DEFAULT_IMAGE_COUNT,
      reference_image_urls: expect.arrayContaining([urls[0]]),
    }), expect.anything());
    expect(result).toMatchObject({ status: 'completed', generation: { call_id: 'call-1', requested_count: 3, generated_count: 3, used_reference_images: true } });
    expect(result.sku_images[0]!.primary_image).toBe(generated[0]);
  });

  it('blocks only when generation is explicitly enabled without a provider', async () => {
    const urls = sourceUrls();
    const bodies = bodiesFor(urls);
    const result = await runImagePipeline({ product: product(urls), generation: { enabled: true }, fetch: fetchFrom(bodies), resolver, agent_review: reviews(bodies) });
    expect(result.status).toBe('blocked');
    expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'IMAGE_PROVIDER_REQUIRED' })]));
  });

  it('deduplicates identical image content while preserving deterministic first URL', async () => {
    const urls = sourceUrls();
    const same = png(9);
    const bodies = new Map(urls.map((url) => [url, same]));
    const result = await runImagePipeline({ product: product(urls), fetch: fetchFrom(bodies), resolver, agent_review: reviews(bodies) });
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]!.url).toBe(urls[0]);
    expect(result.warnings.some((warning) => warning.code === 'DUPLICATE_IMAGE_CONTENT')).toBe(true);
  });

  it('limits default download concurrency to four', async () => {
    const urls = Array.from({ length: 7 }, (_, index) => `https://img.example/${index}.png`);
    const bodies = bodiesFor(urls);
    let active = 0;
    let maximum = 0;
    const execute = vi.fn(async (input: RequestInfo | URL) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      const body = bodies.get(String(input))!;
      return imageResponse(body);
    }) as unknown as typeof fetch;
    await runImagePipeline({ product: product(urls), fetch: execute, resolver });
    expect(maximum).toBe(4);
  });

  it('enforces an overall pipeline timeout and aborts outstanding downloads', async () => {
    const execute = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    })) as unknown as typeof fetch;
    const started = Date.now();
    const result = await runImagePipeline({
      product: product(sourceUrls()), fetch: execute, resolver,
      network: { total_timeout_ms: 20, per_image_timeout_ms: 1_000 },
    });
    expect(Date.now() - started).toBeLessThan(500);
    expect(result.status).toBe('blocked');
    expect(result.errors.every((error) => error.code === 'IMAGE_PIPELINE_TOTAL_TIMEOUT' || error.code === 'SKU_IMAGES_MISSING')).toBe(true);
  });
});

describe('remote image security and streaming', () => {
  it.each(['127.0.0.1', '10.1.2.3', '100.64.0.1', '169.254.169.254', '172.31.2.3', '192.168.1.1', '::1', 'fc00::1', 'fe80::1'])(
    'rejects private or reserved address %s',
    (address) => expect(isForbiddenAddress(address)).toBe(true),
  );

  it('rejects a public hostname when DNS resolves to a private address before fetch', async () => {
    const execute = vi.fn() as unknown as typeof fetch;
    await expect(inspectRemoteImage('https://img.example/a.png', execute, async () => ['10.0.0.2'])).rejects.toThrow('IMAGE_ADDRESS_FORBIDDEN');
    expect(execute).not.toHaveBeenCalled();
  });

  it('revalidates every redirect target and rejects a redirect to private IP', async () => {
    const execute = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private.png' } })) as unknown as typeof fetch;
    await expect(inspectRemoteImage('https://img.example/a.png', execute, resolver)).rejects.toThrow('IMAGE_ADDRESS_FORBIDDEN');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('enforces the byte limit while streaming even without Content-Length and cancels the reader', async () => {
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(8)); controller.enqueue(new Uint8Array(8)); },
      cancel: cancelled,
    });
    const execute = vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'application/octet-stream' } })) as unknown as typeof fetch;
    await expect(inspectRemoteImage('https://img.example/a.png', execute, resolver, { max_image_bytes: 10 })).rejects.toThrow('IMAGE_TOO_LARGE');
    expect(cancelled).toHaveBeenCalled();
  });

  it('preflights Content-Length without consuming an oversized body', async () => {
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel: cancelled });
    const execute = vi.fn(async () => new Response(body, { status: 200, headers: { 'content-length': '999' } })) as unknown as typeof fetch;
    await expect(inspectRemoteImage('https://img.example/a.png', execute, resolver, { max_image_bytes: 10 })).rejects.toThrow('IMAGE_TOO_LARGE');
    expect(cancelled).toHaveBeenCalled();
  });

  it.each([
    ['image/png', png(1), 320, 240],
    ['image/jpeg', jpeg(640, 480), 640, 480],
    ['image/webp', webp(800, 600), 800, 600],
  ] as const)('parses %s metadata from a bounded stream', async (mediaType, body, width, height) => {
    const execute = vi.fn(async () => imageResponse(body, mediaType)) as unknown as typeof fetch;
    const inspected = await inspectRemoteImage(`https://img.example/a.${mediaType.split('/')[1]}`, execute, resolver);
    expect(inspected).toMatchObject({ mediaType, width, height });
  });

  it('enforces exact/wildcard host allowlists and HTTPS policy', async () => {
    await expect(assertRemoteUrlSafe(new URL('https://evil.example/a.png'), resolver, { allowed_hosts: ['*.trusted.example'] })).rejects.toThrow('IMAGE_HOST_NOT_ALLOWED');
    await expect(assertRemoteUrlSafe(new URL('http://cdn.trusted.example/a.png'), resolver, { allowed_hosts: ['*.trusted.example'] })).rejects.toThrow('IMAGE_URL_PROTOCOL_FORBIDDEN');
    await expect(assertRemoteUrlSafe(new URL('https://cdn.trusted.example/a.png'), resolver, { allowed_hosts: ['*.trusted.example'] })).resolves.toBeUndefined();
  });
});

function sourceUrls(): string[] {
  return ['https://img.example/sku.png', 'https://img.example/main.png', 'https://img.example/gallery.webp'];
}

function bodiesFor(urls: string[]): Map<string, Uint8Array> {
  return new Map(urls.map((url, index) => [url, png(index + 1)]));
}

function fetchFrom(bodies: ReadonlyMap<string, Uint8Array>): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const body = bodies.get(String(input));
    if (!body) return new Response(null, { status: 404 });
    return imageResponse(body);
  }) as unknown as typeof fetch;
}

function imageResponse(body: Uint8Array, mediaType = 'image/png'): Response {
  return new Response(body, { status: 200, headers: { 'content-type': mediaType, 'content-length': String(body.byteLength) } });
}

function reviews(bodies: ReadonlyMap<string, Uint8Array>): ImageReviewAgentInputV1 {
  const hashes = [...new Set([...bodies.values()].map((body) => crypto.createHash('sha256').update(body).digest('hex')))];
  return {
    source_offer_id: '1',
    assets: hashes.map((content_sha256) => ({ content_sha256, contains_chinese_text: false, contains_watermark: false, notes: 'offline fixture reviewed' })),
  };
}

function png(seed: number): Uint8Array {
  const bytes = Buffer.alloc(25);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(320, 16);
  bytes.writeUInt32BE(240, 20);
  bytes[24] = seed;
  return bytes;
}

function jpeg(width: number, height: number): Uint8Array {
  const bytes = Buffer.alloc(20);
  bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]);
  bytes.writeUInt16BE(height, 7);
  bytes.writeUInt16BE(width, 9);
  return bytes;
}

function webp(width: number, height: number): Uint8Array {
  const bytes = Buffer.alloc(30);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(22, 4);
  bytes.write('WEBP', 8, 'ascii');
  bytes.write('VP8X', 12, 'ascii');
  writeUInt24LE(bytes, 24, width - 1);
  writeUInt24LE(bytes, 27, height - 1);
  return bytes;
}

function writeUInt24LE(bytes: Buffer, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
}

function product(urls: string[]): CanonicalProductV2 {
  return {
    schema_version: 2,
    source: { platform: '1688', offer_id: '1', offer_url: 'https://detail.1688.com/offer/1.html', collected_at: new Date(0).toISOString(), collection_method: 'offers', detail_url: null, source_category_path_zh: [], discovery_context: { search_term: null, seed_offer_id: null } },
    product: { title_zh: '杯子', main_image: urls[1] ?? urls[0]!, gallery_images: urls.slice(2), attributes: {}, price_tiers: [], sku_options: [] },
    skus: [{ source_sku_id: 'sku-1', raw_spec_text: '红色', specs: { 颜色: '红色' }, unparsed_spec_segments: [], price_cny: 20, multi_price_cny: null, image: urls[0]!, package: { length_cm: 10, width_cm: 10, height_cm: 10, raw_weight: 100, weight_unit: 'g', source: '1688', matched_by: 'sku_id' } }],
    sku_analysis: { has_source_skus: true, is_multi_sku: false, sku_count: 1, common_fields: {}, varying_fields: [], variant_dimensions: [], missing_fields: [], duplicate_spec_combinations: [], warnings: [] },
    validation: { status: 'valid', warnings: [], errors: [] },
  };
}
