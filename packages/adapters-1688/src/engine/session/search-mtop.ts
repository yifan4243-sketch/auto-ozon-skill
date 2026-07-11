import { parseMtopJsonp } from './mtop.js';

export const SEARCH_MTOP_API = 'mtop.relationrecommend.wirelessrecommend.recommend';
export const SEARCH_APP_ID = '32517';

export interface Offer {
  offerId: string;
  title: string;
  price: { text: string; min: number | null; max: number | null };
  url: string;
  image: string | null;
}

export interface RawOfferItem {
  cellType?: string;
  data?: {
    offerId?: string;
    title?: string;
    priceInfo?: { price?: string };
    offerPicUrl?: string;
  };
}

export interface SearchMtopRequestMeta {
  appId?: string;
  method?: string;
  beginPage?: number;
  sortType?: string;
}

export function mapOffer(item: RawOfferItem): Offer | null {
  const d = item.data;
  if (!d?.offerId) return null;
  const title = (d.title ?? '').replace(/<\/?font[^>]*>/g, '').trim();
  const priceRaw = d.priceInfo?.price;
  const price = priceRaw ? parseFloat(priceRaw) : null;
  return {
    offerId: d.offerId,
    title,
    price: {
      text: priceRaw ? `¥${priceRaw}` : '',
      min: price,
      max: price,
    },
    url: `https://detail.1688.com/offer/${d.offerId}.html`,
    image: d.offerPicUrl ?? null,
  };
}

export function readSearchMtopRequestMeta(url: string): SearchMtopRequestMeta | null {
  if (!url.includes(SEARCH_MTOP_API)) return null;
  try {
    const dataParam = new URLSearchParams(new URL(url).search).get('data') ?? '';
    if (!dataParam) return null;
    const dataObj = JSON.parse(dataParam) as {
      appId?: unknown;
      params?: string;
    };
    const params = JSON.parse(dataObj.params ?? '{}') as {
      method?: string;
      beginPage?: number | string;
      sortType?: string;
    };
    const beginPage = params.beginPage === undefined ? undefined : Number(params.beginPage);
    return {
      appId: String(dataObj.appId),
      method: params.method,
      beginPage,
      sortType: params.sortType,
    };
  } catch {
    return null;
  }
}

export function parseOfferItemsFromMtopText(text: string): Offer[] {
  const json = parseMtopJsonp<{
    data?: { data?: { OFFER?: { items?: RawOfferItem[] } } };
  }>(text);
  const items = json?.data?.data?.OFFER?.items ?? [];
  return items.map(mapOffer).filter((o): o is Offer => o !== null);
}
