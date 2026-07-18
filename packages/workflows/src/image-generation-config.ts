import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  ImageGenerationLocalConfigV1,
  ImageGenerationProviderV1,
  ImageGenerationRequestV1,
  ImageGenerationResponseV1,
} from '@auto-ozon/contracts';
import { resolveRepoRoot } from '@auto-ozon/artifact-store';
import { loadOzonEnvironment } from '@auto-ozon/adapters-ozon';
import { DEFAULT_IMAGE_PROMPT_VERSION, type ImagePipelineGenerationOptionsV1 } from '@auto-ozon/image-pipeline';

export interface ConfiguredImageGenerationV1 {
  config: ImageGenerationLocalConfigV1;
  options: ImagePipelineGenerationOptionsV1;
  provider: ImageGenerationProviderV1;
}

export async function loadConfiguredImageGeneration(
  repoRoot = resolveRepoRoot(),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ConfiguredImageGenerationV1> {
  const file = path.join(repoRoot, 'data', 'config', 'image-generation.local.json');
  const config = validateImageGenerationConfig(JSON.parse(await fs.readFile(file, 'utf8')) as unknown);
  const resolvedEnvironment = loadOzonEnvironment(environment, repoRoot);
  const apiKey = resolvedEnvironment[config.api_key_env]?.trim();
  if (!apiKey) throw new Error('IMAGE_GENERATION_SECRET_MISSING');
  return {
    config,
    options: {
      enabled: true,
      count: config.image_count,
      use_reference_images: config.use_1688_reference_images,
      generated_images_as_primary: true,
    },
    provider: new LocalHttpImageGenerationProvider(config, apiKey),
  };
}

export function validateImageGenerationConfig(value: unknown): ImageGenerationLocalConfigV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('IMAGE_GENERATION_CONFIG_INVALID');
  const config = value as Partial<ImageGenerationLocalConfigV1>;
  if (config.schema_version !== 1
    || typeof config.provider_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(config.provider_id)
    || typeof config.model !== 'string' || !config.model.trim()
    || typeof config.api_key_env !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/u.test(config.api_key_env)
    || typeof config.use_1688_reference_images !== 'boolean'
    || !Number.isSafeInteger(config.image_count) || config.image_count! < 1 || config.image_count! > 15
    || config.prompt_version !== DEFAULT_IMAGE_PROMPT_VERSION) throw new Error('IMAGE_GENERATION_CONFIG_INVALID');
  let url: URL;
  try { url = new URL(String(config.base_url)); } catch { throw new Error('IMAGE_GENERATION_BASE_URL_INVALID'); }
  const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !localHttp) throw new Error('IMAGE_GENERATION_BASE_URL_UNSAFE');
  url.username = ''; url.password = ''; url.search = ''; url.hash = '';
  return { ...config, base_url: url.toString().replace(/\/$/u, '') } as ImageGenerationLocalConfigV1;
}

class LocalHttpImageGenerationProvider implements ImageGenerationProviderV1 {
  constructor(private readonly config: ImageGenerationLocalConfigV1, private readonly apiKey: string) {}

  async generate(request: ImageGenerationRequestV1, signal?: AbortSignal): Promise<ImageGenerationResponseV1> {
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => controller.abort(), 100_000);
    try {
      const response = await fetch(`${this.config.base_url}/images/generations`, {
        method: 'POST', signal: controller.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.config.model,
          prompt: request.prompt,
          n: request.count,
          response_format: 'url',
          reference_image_urls: request.reference_image_urls,
        }),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`IMAGE_GENERATION_HTTP_${response.status}`);
      let payload: unknown;
      try { payload = JSON.parse(text); } catch { throw new Error('IMAGE_GENERATION_RESPONSE_INVALID'); }
      const object = payload as { id?: unknown; data?: Array<{ url?: unknown }>; images?: unknown[] };
      const urls = [
        ...(Array.isArray(object.data) ? object.data.map((item) => item?.url) : []),
        ...(Array.isArray(object.images) ? object.images : []),
      ].filter((item): item is string => typeof item === 'string');
      if (urls.length === 0) throw new Error('IMAGE_GENERATION_URLS_MISSING');
      const responseHash = createHash('sha256').update(text).digest('hex');
      return {
        provider_id: this.config.provider_id,
        model_id: this.config.model,
        call_id: typeof object.id === 'string' && object.id ? object.id : response.headers.get('x-request-id') ?? `${randomUUID()}-${responseHash.slice(0, 12)}`,
        image_urls: urls,
      };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }
}
