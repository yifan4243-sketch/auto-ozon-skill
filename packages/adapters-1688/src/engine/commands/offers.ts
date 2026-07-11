import type { BrowserContext, Page } from 'playwright';
import { dispatch } from '../session/dispatch.js';
import { emit, info } from '../io/output.js';
import { CliError } from '../io/errors.js';
import { withRecovery } from '../session/recovery.js';
import { sleep } from '../session/wait.js';
import { parseMtop } from '../session/mtop.js';
import { startResponseCapture } from '../session/response-capture.js';

export interface OffersOpts {
  offerId?: string;
  offerIds?: string[];
  profile?: string;
  headed?: boolean;
}

export interface OfferFailure {
  offerId: string;
  code: string;
  message: string;
}

export interface OfferBatchResult {
  mode: 'offers';
  total: number;
  success: number;
  failed: number;
  offerIds: string[];
  offers: OfferResult[];
  failures: OfferFailure[];
}

export interface OfferArgs {
  offerId: string;
  headed?: boolean;
}

export interface OfferResult {
  offerId: string;
  title: string;
  url: string;
  /** Visible 1688 category breadcrumb, ordered from broad to specific. */
  categoryPathZh: string[];
  priceRange: string | null;
  priceMin: number | null;
  priceMax: number | null;
  /** Display unit ("件" / "个" / "米" ...) */
  unitName: string | null;
  /** 起订量 — minimum order quantity for a single SKU buy. */
  minOrderQty: number | null;
  /** 混批起订量 — minimum quantity when mixing SKUs in one order. */
  mixOrderQty: number | null;
  /** Bulk-discount tiers, e.g. [{minQty: 1, price: 4.16}, {minQty: 100, price: 3.50}]. */
  priceTiers: PriceTier[];
  /** Long-form detail page URL (rich images / text). */
  detailUrl: string | null;
  /** Product attributes (材质 / 规格 / 产地 ...). Empty when the seller
   *  didn't fill them in. */
  attributes: ProductAttribute[];
  /** Per-SKU package dimensions (件重尺) when the seller filled them in.
   *  Empty array for small items (clothes, etc.) where 1688 omits this. */
  packageInfo: SkuPackage[];
  options: SkuOption[];
  skus: SkuVariant[];
  mainImage: string | null;
  images: string[];
}

export interface PriceTier {
  minQty: number;
  price: number;
}

export interface ProductAttribute {
  name: string;
  value: string;
}

export interface SkuPackage {
  skuId: string;
  spec: string;
  /** cm */
  length: number | null;
  width: number | null;
  height: number | null;
  /** Stated weight (raw value — 1688 sometimes uses grams or kg per offer). */
  weight: number | null;
}

export interface SkuOption {
  prop: string;
  values: { name: string; imageUrl: string | null }[];
}

export interface SkuVariant {
  skuId: string;
  specs: string;
  price: number | null;
  /** Bulk-tier price when 1688 surfaces a separate multi-piece price. */
  multiPrice: number | null;
  /** Best-effort image URL derived from the first option (颜色/款式) match. */
  image: string | null;
}

const SKU_API_RE = /wosc\.queryofferskuselectormodel/i;

export async function execute(
  ctx: BrowserContext,
  args: OfferArgs,
): Promise<OfferResult> {
  if (!/^\d+$/.test(args.offerId)) {
    throw new CliError(2, 'BAD_INPUT', `Invalid offerId: ${args.offerId}`);
  }
  return withRecovery(
    ctx,
    { cmd: 'offers', args },
    () => executeRaw(ctx, args),
    { headed: args.headed === true, maxRetries: 1 },
  );
}

export async function executeRaw(
  ctx: BrowserContext,
  args: OfferArgs,
): Promise<OfferResult> {
  const page = await ctx.newPage();

  const skuCapture = startResponseCapture<SkuBizModel>({
    page,
    timeoutMs: 18000,
    matcher: SKU_API_RE,
    parse: async (resp) => {
      const text = await resp.text();
      const json = parseMtop<{ data?: { skuSelectorBizModel?: SkuBizModel } }>(
        text,
      );
      return json?.data?.skuSelectorBizModel ?? null;
    },
  });

  const url = `https://detail.1688.com/offer/${args.offerId}.html`;
  try {
    info(`Fetching offer ${args.offerId}...`);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
      throw new CliError(
        9,
        'NETWORK_ERROR',
        `Failed to load offer page: ${(e as Error).message}`,
      );
    }
    if (/login\.1688\.com|login\.taobao\.com/.test(page.url())) {
      throw new CliError(
        3,
        'NOT_LOGGED_IN',
        'Session expired. Run `1688 login`.',
      );
    }

    const sku = await skuCapture.wait();
    const pageInfo = await readPageInfo(page);
    return assemble(args.offerId, url, sku, pageInfo);
  } finally {
    skuCapture.dispose();
  }
}

interface SkuBizModel {
  skuProps?: { prop?: string; value?: { name?: string; imageUrl?: string }[] }[];
  skuInfoMap?: Record<
    string,
    {
      skuId?: string;
      specAttrs?: string;
      price?: string;
      discountPrice?: string;
      multiPrice?: string;
    }
  >;
  skuPriceScale?: string;
  skuSelectorModel?: {
    tradeModel?: {
      beginAmount?: number | string;
      unit?: string;
      mixModel?: { mixAmount?: number | string };
      offerPriceModel?: {
        currentPrices?: { beginAmount?: number | string; price?: number | string }[];
      };
    };
  };
}

interface PageInfo {
  title: string;
  categoryPathZh: string[];
  mainImage: string | null;
  images: string[];
  detailUrl: string | null;
  attributes: ProductAttribute[];
  packageInfo: SkuPackage[];
}

/**
 * Extract product info from the inline `window.context.result.data` JS
 * object that 1688 ships in the SSR HTML response. Bypasses fragile DOM
 * selectors by letting Playwright serialize the parsed JS object back to
 * Node over the wire.
 *
 * Falls back to DOM scraping if the inline data isn't available for some
 * reason (e.g. server rendered a fallback view).
 */
export interface ReadPageInfoOptions {
  contextTimeoutMs?: number;
  scrollDelayMs?: number;
}

export async function readPageInfo(
  page: Page,
  options: ReadPageInfoOptions = {},
): Promise<PageInfo> {
  const contextTimeoutMs = options.contextTimeoutMs ?? 8000;
  const scrollDelayMs = options.scrollDelayMs ?? 1000;
  const debug = process.env.BB1688_DEBUG === '1';
  if (debug) {
    page.on('console', (msg) => {
      const t = msg.text();
      if (t.includes('[bb1688-probe]') || t.includes('[bb1688]'))
        process.stderr.write(t + '\n');
    });
  }

  try {
    await page.waitForFunction(
      () => {
        const w = window as unknown as {
          context?: {
            result?: { data?: { productTitle?: { fields?: object } } };
          };
        };
        return !!w.context?.result?.data?.productTitle?.fields;
      },
      undefined,
      { timeout: contextTimeoutMs },
    );
  } catch {
    return scrapeDomFallback(page);
  }
  // Modest scroll to trigger lazy modules near the SKU + 参数 section.
  // Avoid scrolling to bottom — 1688 detail pages infinite-scroll related
  // products there, which can hang the renderer.
  try {
    await page.evaluate(() => window.scrollTo(0, 1500));
    await sleep(scrollDelayMs);
    await page.evaluate(() => window.scrollTo(0, 3000));
    await sleep(scrollDelayMs);
  } catch {
    /* best-effort */
  }

  const fromContext = await page.evaluate(() => {
      type ImageEntry =
        | string
        | {
            fullPathImageURI?: string;
            imageURI?: string;
            size310x310ImageURI?: string;
          };
      type OfferData = {
        subject?: string;
        images?: ImageEntry[];
      };
      const w = window as unknown as {
        context?: { result?: { data?: OfferData } };
      };
      const d = w.context?.result?.data as Record<string, unknown> | undefined;
      if (!d) return null;

      // Description content is retained, but numeric category identifiers are not.
      const descFields = (d.description as {
        fields?: {
          detailUrl?: string;
          detailVideoId?: string;
        };
      })?.fields ?? {};

      // Product attributes live in a deeply-nested branch (1688 typically
      // serializes them under `globalData.model.offerDetail.featureAttributes`,
      // but the wrapping path varies). Walk the entire window.context tree
      // (bounded depth) looking for the canonical featureAttributes array.
      const attributes: { name: string; value: string }[] = [];
      const root = (w.context ?? d) as Record<string, unknown>;
      const stack: { v: unknown; depth: number }[] = [{ v: root, depth: 0 }];
      while (stack.length && attributes.length === 0) {
        const { v, depth } = stack.shift()!;
        if (depth > 12) continue;
        if (!v || typeof v !== 'object') continue;
        if (Array.isArray(v)) {
          // Detect attribute-list array shape.
          if (v.length > 0 && typeof v[0] === 'object' && v[0] !== null) {
            const first = v[0] as Record<string, unknown>;
            if (
              typeof first.name === 'string' &&
              ('value' in first || 'values' in first)
            ) {
              for (const item of v) {
                if (!item || typeof item !== 'object') continue;
                const it = item as Record<string, unknown>;
                const name =
                  typeof it.name === 'string' ? it.name.trim() : '';
                let value = '';
                if (typeof it.value === 'string') value = it.value;
                else if (Array.isArray(it.values))
                  value = (it.values as unknown[])
                    .filter((x) => typeof x === 'string')
                    .join(',');
                if (name && value) attributes.push({ name, value });
              }
            }
          }
          for (const item of v) stack.push({ v: item, depth: depth + 1 });
        } else {
          // Prioritize keys that hint at attribute containers.
          const obj = v as Record<string, unknown>;
          // Direct hit
          const direct =
            obj.featureAttributes ?? obj.productAttributes ?? obj.attributes;
          if (Array.isArray(direct))
            stack.unshift({ v: direct, depth: depth + 1 });
          for (const k of Object.keys(obj))
            stack.push({ v: obj[k], depth: depth + 1 });
        }
      }

      // Package info — per-SKU dimensions/weight (件重尺).
      const packRaw = (
        d.productPackInfo as {
          fields?: { pieceWeightScale?: { pieceWeightScaleInfo?: unknown[] } };
        }
      )?.fields?.pieceWeightScale?.pieceWeightScaleInfo;
      const packageInfo: {
        skuId: string;
        spec: string;
        length: number | null;
        width: number | null;
        height: number | null;
        weight: number | null;
      }[] = [];
      if (Array.isArray(packRaw)) {
        for (const p of packRaw) {
          if (!p || typeof p !== 'object') continue;
          const o = p as {
            skuId?: number | string;
            sku1?: string;
            length?: number;
            width?: number;
            height?: number;
            weight?: number;
          };
          packageInfo.push({
            skuId: o.skuId != null ? String(o.skuId) : '',
            spec: o.sku1 ?? '',
            length: o.length ?? null,
            width: o.width ?? null,
            height: o.height ?? null,
            weight: o.weight ?? null,
          });
        }
      }

      // Page is organized by widget modules; real data lives in `<mod>.fields`.
      const productTitle = (d.productTitle as {
        fields?: {
          title?: string;
          unit?: string;
        };
      })?.fields ?? {};
      const gallery = (d.gallery as {
        fields?: {
          mainImage?: unknown;
          offerId?: number | string;
          subject?: string;
          video?: { coverUrl?: string; videoId?: string };
        };
      })?.fields ?? {};
      const imgs: string[] = [];
      const rawImgs = gallery.mainImage;
      if (Array.isArray(rawImgs)) {
        for (const img of rawImgs) {
          if (typeof img === 'string') imgs.push(img);
          else if (img && typeof img === 'object') {
            const o = img as {
              fullPathImageURI?: string;
              size310x310ImageURI?: string;
              imageURI?: string;
            };
            const url =
              o.fullPathImageURI ?? o.size310x310ImageURI ?? o.imageURI ?? '';
            if (url) {
              imgs.push(
                url.startsWith('http') ? url : `https://cbu01.alicdn.com/${url}`,
              );
            }
          }
        }
      }
      const categoryCandidates: string[][] = [];
      for (const key of [
        'breadcrumb',
        'breadcrumbs',
        'breadCrumb',
        'categoryPath',
        'categoryNavigation',
      ]) {
        const candidate: string[] = [];
        const pending: Array<{ value: unknown; depth: number }> = [
          { value: d[key], depth: 0 },
        ];
        while (pending.length > 0) {
          const current = pending.shift()!;
          if (
            current.depth > 4 ||
            current.value === null ||
            current.value === undefined
          ) {
            continue;
          }
          if (typeof current.value === 'string') {
            candidate.push(current.value);
            continue;
          }
          if (Array.isArray(current.value)) {
            for (const item of current.value) {
              pending.push({ value: item, depth: current.depth + 1 });
            }
            continue;
          }
          if (typeof current.value !== 'object') continue;
          const entry = current.value as Record<string, unknown>;
          let foundLabel = false;
          for (const labelKey of [
            'name',
            'title',
            'text',
            'categoryName',
            'label',
          ]) {
            if (typeof entry[labelKey] === 'string') {
              candidate.push(entry[labelKey] as string);
              foundLabel = true;
              break;
            }
          }
          if (foundLabel) continue;
          for (const containerKey of [
            'fields',
            'items',
            'list',
            'categories',
            'path',
            'children',
          ]) {
            if (entry[containerKey] !== undefined) {
              pending.push({
                value: entry[containerKey],
                depth: current.depth + 1,
              });
            }
          }
        }
        if (candidate.length > 0) categoryCandidates.push(candidate);
      }
      for (const selector of [
        '[class*="breadcrumb"]',
        '[class*="bread-crumb"]',
        '[class*="crumb"]',
        '[data-testid*="breadcrumb"]',
      ]) {
        for (const container of document.querySelectorAll(selector)) {
          const candidate = [...container.querySelectorAll('a, span')]
            .map((node) => node.textContent?.trim() ?? '')
            .filter(Boolean);
          if (candidate.length > 0) categoryCandidates.push(candidate);
        }
      }
      const categoryPathZh = categoryCandidates.sort(
        (left, right) => right.length - left.length,
      )[0] ?? [];
      return {
        detailUrl: descFields.detailUrl ?? null,
        attributes,
        packageInfo,
        title: productTitle.title ?? gallery.subject ?? '',
        categoryPathZh,
        mainImage: imgs[0] ?? null,
        images: imgs,
      };
    });

  if (!fromContext) return scrapeDomFallback(page);

  // Title from <title> as backup when subject empty.
  let title = fromContext.title;
  if (!title) {
    const raw = await page.title();
    title = raw.replace(/\s*-\s*阿里巴巴\s*$/, '').trim();
  }
  return {
    ...fromContext,
    title,
    categoryPathZh: normalizeCategoryPathZh(fromContext.categoryPathZh),
  };
}

async function scrapeDomFallback(page: Page): Promise<PageInfo> {
  const raw = await page.title();
  const title = raw.replace(/\s*-\s*阿里巴巴\s*$/, '').trim();
  const info = await page.evaluate(() => {
    const primaryImage = document.querySelector(
      '.v-image-wrap img',
    ) as HTMLImageElement | null;
    const antImage = document.querySelector(
      '.ant-image-img',
    ) as HTMLImageElement | null;
    const altImage = document.querySelector(
      'img[alt*="主图"]',
    ) as HTMLImageElement | null;
    const mainImageElement = primaryImage ?? antImage ?? altImage;
    return {
      mainImage:
        mainImageElement?.src ??
        mainImageElement?.getAttribute('data-src') ??
        null,
      categoryPathZh: [...document.querySelectorAll(
        '[class*="breadcrumb"] a, [class*="breadcrumb"] span, [class*="crumb"] a, [class*="crumb"] span',
      )].map((node) => node.textContent?.trim() ?? '').filter(Boolean),
    };
  });
  return {
    title,
    categoryPathZh: normalizeCategoryPathZh(info.categoryPathZh),
    mainImage: info.mainImage,
    images: info.mainImage ? [info.mainImage] : [],
    detailUrl: null,
    attributes: [],
    packageInfo: [],
  };
}

function assemble(
  offerId: string,
  url: string,
  sku: SkuBizModel | null,
  info: PageInfo,
): OfferResult {
  const priceRange = sku?.skuPriceScale ?? null;
  const { min: priceMin, max: priceMax } = parseRange(priceRange);

  const options: SkuOption[] = (sku?.skuProps ?? []).map((p) => ({
    prop: p.prop ?? '',
    values: (p.value ?? []).map((v) => ({
      name: v.name ?? '',
      imageUrl: v.imageUrl ?? null,
    })),
  }));

  // Build a map: option value name → image (e.g. "22管径长方头" → cbu URL).
  // Used to derive a per-SKU image since the SKU itself doesn't carry one.
  const valueImage = new Map<string, string>();
  for (const opt of options) {
    for (const v of opt.values) {
      if (v.imageUrl) valueImage.set(v.name, v.imageUrl);
    }
  }
  // SKU specs is HTML-encoded ("&gt;" = ">"). Split by either, take first part.
  // Falls back to the offer's main image when the seller didn't upload
  // per-spec thumbnails — keeps every SKU with a usable preview URL.
  const fallbackSkuImage =
    info.mainImage ?? options[0]?.values[0]?.imageUrl ?? null;
  function deriveSkuImage(spec: string): string | null {
    const firstPart = spec.split(/&gt;|>/)[0]?.trim() ?? '';
    return valueImage.get(firstPart) ?? fallbackSkuImage;
  }

  const skus: SkuVariant[] = Object.entries(sku?.skuInfoMap ?? {}).map(
    ([k, v]) => {
      const specs = v.specAttrs ?? k;
      return {
        skuId: v.skuId ?? '',
        specs,
        price: parseFloatOrNull(v.discountPrice ?? v.price),
        multiPrice: parseFloatOrNull(v.multiPrice),
        image: deriveSkuImage(specs),
      };
    },
  );

  const fallbackImage =
    info.mainImage ?? options[0]?.values[0]?.imageUrl ?? null;

  const trade = sku?.skuSelectorModel?.tradeModel;
  const priceTiers: PriceTier[] = (trade?.offerPriceModel?.currentPrices ?? [])
    .map((t) => ({
      minQty: parseIntOrNull(String(t.beginAmount ?? '')) ?? 0,
      price: parseFloatOrNull(String(t.price ?? '')) ?? 0,
    }))
    .filter((t) => t.minQty > 0 && t.price > 0);
  return {
    offerId,
    title: info.title,
    url,
    categoryPathZh: info.categoryPathZh,
    priceRange,
    priceMin,
    priceMax,
    unitName: trade?.unit ?? null,
    minOrderQty: parseIntOrNull(String(trade?.beginAmount ?? '')),
    mixOrderQty: parseIntOrNull(String(trade?.mixModel?.mixAmount ?? '')),
    priceTiers,
    detailUrl: info.detailUrl,
    attributes: info.attributes,
    packageInfo: info.packageInfo,
    options,
    skus,
    mainImage: fallbackImage,
    images: info.images,
  };
}

function parseRange(s: string | null): { min: number | null; max: number | null } {
  if (!s) return { min: null, max: null };
  const matches = Array.from(s.matchAll(/([\d.]+)/g)).map((m) => parseFloat(m[1]!));
  if (matches.length === 0) return { min: null, max: null };
  return {
    min: matches[0] ?? null,
    max: matches.length > 1 ? matches[1]! : matches[0]!,
  };
}

function parseFloatOrNull(s: string | undefined): number | null {
  if (s === undefined) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function parseIntOrNull(s: string | undefined): number | null {
  if (s === undefined) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

export async function run(opts: OffersOpts): Promise<void> {
  const ids = opts.offerIds?.length
    ? opts.offerIds
    : opts.offerId
      ? [opts.offerId]
      : [];

  if (ids.length === 0) {
    throw new CliError(2, 'BAD_INPUT', 'offerId required.');
  }

  const result = await collectOffersBatch(ids, opts);

  emit({
    human: () => printBatch(result),
    data: result,
  });
}

export function normalizeOfferIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of ids) {
    const id = String(raw ?? '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    normalized.push(id);
  }
  return normalized;
}

export async function collectOffersBatch(
  ids: string[],
  opts: Pick<OffersOpts, 'profile' | 'headed'> = {},
): Promise<OfferBatchResult> {
  const offerIds = normalizeOfferIds(ids);
  const offers: OfferResult[] = [];
  const failures: OfferFailure[] = [];

  for (let i = 0; i < offerIds.length; i++) {
    const offerId = offerIds[i]!;
    if (!/^\d+$/.test(offerId)) {
      failures.push({ offerId, code: 'BAD_INPUT', message: 'Invalid offerId' });
      continue;
    }

    process.stderr.write(`[${i + 1}/${ids.length}] collecting offerId ${offerId}\n`);

    try {
      const data = await dispatch<OfferArgs, OfferResult>(
        'offers',
        { offerId, headed: opts.headed },
        { headed: opts.headed, profile: opts.profile },
      );
      offers.push(data);
    } catch (error) {
      const err = error as Error & { code?: string };
      const message = sanitiseFailMessage(err.message || String(error));
      failures.push({
        offerId,
        code: err.code || 'DEEP_COLLECT_FAILED',
        message,
      });
    }
  }

  return {
    mode: 'offers',
    total: offerIds.length,
    success: offers.length,
    failed: failures.length,
    offerIds,
    offers,
    failures,
  };
}

function printOffer(o: OfferResult): void {
  process.stdout.write(`${o.title}\n`);
  process.stdout.write(`  offerId:  ${o.offerId}\n`);
  if (o.priceRange) {
    process.stdout.write(`  price:    ${o.priceRange}\n`);
  } else if (o.priceMin !== null) {
    const range =
      o.priceMax !== null && o.priceMax !== o.priceMin
        ? `¥${o.priceMin.toFixed(2)} - ¥${o.priceMax.toFixed(2)}`
        : `¥${o.priceMin.toFixed(2)}`;
    process.stdout.write(`  price:    ${range}\n`);
  }
  if (o.categoryPathZh.length > 0) {
    process.stdout.write(`  category: ${o.categoryPathZh.join(' > ')}\n`);
  }
  process.stdout.write(`  url:      ${o.url}\n`);
  if (o.options.length) {
    process.stdout.write(`\nOptions (${o.options.length}):\n`);
    for (const opt of o.options) {
      process.stdout.write(
        `  ${opt.prop}: ${opt.values.map((v) => v.name).slice(0, 5).join(' | ')}`,
      );
      if (opt.values.length > 5)
        process.stdout.write(` ... (+${opt.values.length - 5})`);
      process.stdout.write('\n');
    }
  }
  if (o.skus.length) {
    const sample = o.skus.slice(0, 5);
    process.stdout.write(`\nSKUs (${o.skus.length} total, showing ${sample.length}):\n`);
    for (const s of sample) {
      const price = s.price !== null ? `¥${s.price.toFixed(2)}` : '?';
      process.stdout.write(`  ${price.padEnd(10)} ${s.specs}\n`);
    }
  }
}

export function normalizeCategoryPathZh(values: readonly string[]): string[] {
  const ignored = new Set([
    '首页',
    '阿里巴巴',
    '阿里巴巴首页',
    '1688',
    '1688首页',
    '所有分类',
    '商品分类',
  ]);
  const normalized: string[] = [];
  for (const raw of values) {
    for (const part of raw.split(/\s*(?:>|›|»|→)\s*/u)) {
      const value = part.replace(/^[\s/|·-]+|[\s/|·-]+$/gu, '').trim();
      if (!value || ignored.has(value) || /^\d+$/.test(value)) continue;
      if (/^https?:\/\//i.test(value) || value.length > 80) continue;
      if (normalized.at(-1) !== value) normalized.push(value);
    }
  }
  return normalized;
}

function printBatch(result: OfferBatchResult): void {
  process.stdout.write(
    `Batch offer results: ${result.success}/${result.total} ok` +
      (result.failed ? `, ${result.failed} failed` : '') +
      '\n\n',
  );
  for (const o of result.offers) {
    process.stdout.write(
      `${o.offerId} | ${(o.title || '').slice(0, 80)}\n` +
        `  SKUs: ${o.skus.length} | packages: ${o.packageInfo.length}` +
        (o.priceRange ? ` | price: ${o.priceRange}` : '') +
        '\n\n',
    );
  }
  if (result.failures.length > 0) {
    process.stdout.write('Failures:\n');
    for (const f of result.failures) {
      process.stdout.write(`  ${f.offerId}  ${f.code}  ${f.message}\n`);
    }
  }
}

/** Strip long risk-control URLs from error messages. */
function sanitiseFailMessage(message: string): string {
  if (/x5secdata|punish|captcha|verify|nocaptcha/i.test(message)) {
    return '1688 触发滑块验证，请使用 --headed 手动处理。';
  }
  return message;
}
