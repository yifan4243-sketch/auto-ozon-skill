import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import type { ImageAssetV1 } from '@auto-ozon/contracts';

export const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const DEFAULT_IMAGE_TIMEOUT_MS = 15_000;
export const DEFAULT_IMAGE_TOTAL_TIMEOUT_MS = 45_000;
export const DEFAULT_IMAGE_CONCURRENCY = 4;
const MAX_REDIRECTS = 5;

export type ImageHostResolverV1 = (hostname: string) => Promise<readonly string[]>;

export interface ImageFetchPolicyV1 {
  /** Optional exact/wildcard CDN allowlist. Empty means any public HTTPS host. */
  allowed_hosts?: string[];
  /** Explicit hosts allowed to use plain HTTP. Private/reserved addresses remain forbidden. */
  allow_http_hosts?: string[];
  max_image_bytes?: number;
  per_image_timeout_ms?: number;
  total_timeout_ms?: number;
  concurrency?: number;
}

export interface InspectedRemoteImageV1 {
  bytes: Buffer;
  mediaType: ImageAssetV1['media_type'];
  width: number;
  height: number;
  contentSha256: string;
  finalUrl: string;
}

export async function inspectRemoteImage(
  rawUrl: string,
  execute: typeof fetch,
  resolver: ImageHostResolverV1 = resolveHost,
  policy: ImageFetchPolicyV1 = {},
  parentSignal?: AbortSignal,
): Promise<InspectedRemoteImageV1> {
  const maxBytes = positiveInteger(policy.max_image_bytes, DEFAULT_MAX_IMAGE_BYTES);
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) forwardAbort();
  else parentSignal?.addEventListener('abort', forwardAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('IMAGE_FETCH_TIMEOUT')), positiveInteger(policy.per_image_timeout_ms, DEFAULT_IMAGE_TIMEOUT_MS));
  try {
    let current = new URL(rawUrl);
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      await assertRemoteUrlSafe(current, resolver, policy);
      const response = await execute(current, { method: 'GET', redirect: 'manual', signal: controller.signal });
      if (isRedirect(response.status)) {
        if (redirects === MAX_REDIRECTS) throw new Error('IMAGE_REDIRECT_LIMIT_EXCEEDED');
        const location = response.headers.get('location');
        if (!location) throw new Error('IMAGE_REDIRECT_LOCATION_MISSING');
        await response.body?.cancel('IMAGE_REDIRECT').catch(() => undefined);
        current = new URL(location, current);
        continue;
      }
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        await response.body?.cancel('IMAGE_TOO_LARGE').catch(() => undefined);
        throw new Error('IMAGE_TOO_LARGE');
      }
      const bytes = await readBoundedBody(response, maxBytes);
      const metadata = decodeImageMetadata(bytes);
      const declaredType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
      if (declaredType && declaredType !== 'application/octet-stream' && declaredType !== metadata.mediaType) {
        throw new Error('IMAGE_CONTENT_TYPE_MISMATCH');
      }
      return {
        bytes,
        ...metadata,
        contentSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        finalUrl: current.href,
      };
    }
    throw new Error('IMAGE_REDIRECT_LIMIT_EXCEEDED');
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(parentSignal?.aborted ? 'IMAGE_FETCH_ABORTED' : 'IMAGE_FETCH_TIMEOUT');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener('abort', forwardAbort);
  }
}

export async function assertRemoteUrlSafe(
  url: URL,
  resolver: ImageHostResolverV1 = resolveHost,
  policy: ImageFetchPolicyV1 = {},
): Promise<void> {
  const hostname = normalizeHostname(url.hostname);
  if (url.protocol !== 'https:') {
    if (url.protocol !== 'http:' || !hostMatches(hostname, policy.allow_http_hosts ?? [])) {
      throw new Error('IMAGE_URL_PROTOCOL_FORBIDDEN');
    }
  }
  if ((policy.allowed_hosts?.length ?? 0) > 0 && !hostMatches(hostname, policy.allowed_hosts!)) {
    throw new Error('IMAGE_HOST_NOT_ALLOWED');
  }
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) throw new Error('IMAGE_HOST_FORBIDDEN');
  const addresses = net.isIP(hostname) ? [hostname] : await resolver(hostname);
  if (addresses.length === 0) throw new Error('IMAGE_DNS_EMPTY');
  if (addresses.some(isForbiddenAddress)) throw new Error('IMAGE_ADDRESS_FORBIDDEN');
}

export function isForbiddenAddress(rawAddress: string): boolean {
  const address = normalizeHostname(rawAddress);
  const family = net.isIP(address);
  if (family === 4) {
    return [
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
      ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
      ['224.0.0.0', 4], ['240.0.0.0', 4],
    ].some(([network, prefix]) => ipv4InCidr(address, network as string, prefix as number));
  }
  if (family === 6) {
    const value = address.toLowerCase();
    const mapped = value.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/u)?.[1];
    if (mapped) return isForbiddenAddress(mapped);
    return value === '::' || value === '::1'
      || /^(?:fc|fd)/u.test(value)
      || /^(?:fe[89ab])/u.test(value)
      || value.startsWith('ff')
      || value.startsWith('2001:db8:')
      || value.startsWith('2001:10:');
  }
  return true;
}

export function decodeImageMetadata(bytes: Buffer): { mediaType: ImageAssetV1['media_type']; width: number; height: number } {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return dimensions('image/png', bytes.readUInt32BE(16), bytes.readUInt32BE(20));
  }
  if (bytes.length >= 12 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1]!;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return dimensions('image/jpeg', bytes.readUInt16BE(offset + 7), bytes.readUInt16BE(offset + 5));
      }
      if (marker === 0xd9 || marker === 0xda) break;
      const length = bytes.readUInt16BE(offset + 2);
      if (length < 2) break;
      offset += 2 + length;
    }
    throw new Error('JPEG_DIMENSIONS_INVALID');
  }
  if (bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = bytes.toString('ascii', 12, 16);
    if (chunk === 'VP8X') return dimensions('image/webp', 1 + readUInt24LE(bytes, 24), 1 + readUInt24LE(bytes, 27));
    if (chunk === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      return dimensions('image/webp', bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff);
    }
    if (chunk === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
      const bits = bytes.readUInt32LE(21);
      return dimensions('image/webp', (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    throw new Error('WEBP_DIMENSIONS_INVALID');
  }
  throw new Error('IMAGE_FORMAT_UNSUPPORTED_OR_DAMAGED');
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) throw new Error('IMAGE_BODY_MISSING');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel('IMAGE_TOO_LARGE').catch(() => undefined);
        throw new Error('IMAGE_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw new Error('IMAGE_EMPTY');
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

async function resolveHost(hostname: string): Promise<readonly string[]> {
  const results = await dns.lookup(hostname, { all: true, verbatim: true });
  return results.map((entry) => entry.address);
}

function hostMatches(hostname: string, patterns: string[]): boolean {
  return patterns.some((rawPattern) => {
    const pattern = normalizeHostname(rawPattern);
    return pattern.startsWith('*.')
      ? hostname.endsWith(pattern.slice(1)) && hostname !== pattern.slice(2)
      : hostname === pattern;
  });
}

function normalizeHostname(value: string): string {
  return value.trim().replace(/^\[|\]$/gu, '').replace(/\.$/u, '').toLowerCase();
}
function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? value! : fallback;
}
function isRedirect(status: number): boolean { return [301, 302, 303, 307, 308].includes(status); }
function dimensions(mediaType: ImageAssetV1['media_type'], width: number, height: number) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width > 100_000 || height > 100_000) {
    throw new Error('IMAGE_DIMENSIONS_INVALID');
  }
  return { mediaType, width, height };
}
function readUInt24LE(bytes: Buffer, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function ipv4InCidr(address: string, network: string, prefix: number): boolean {
  const value = ipv4ToNumber(address);
  const base = ipv4ToNumber(network);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (base & mask);
}

function ipv4ToNumber(address: string): number {
  return address.split('.').reduce((value, part) => ((value << 8) | Number(part)) >>> 0, 0);
}
