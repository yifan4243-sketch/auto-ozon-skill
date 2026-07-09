export interface CanonicalProduct {
  source: {
    platform: '1688';
    offerId: string;
    offerUrl: string;
    collectedAt: string;
    collectionMethod: 'keyword' | 'image' | 'offers' | 'similar';
  };

  supplier: {
    name?: string | null;
    loginId?: string | null;
    memberId?: string | null;
    userId?: string | null;
    location?: string | null;
  };

  product: {
    chineseTitle: string;
    originalImages: string[];
    detailImages: string[];
    attributes: Record<string, string>;
    priceTiers: Array<{
      minQty: number;
      priceCny: number;
    }>;
    skus: Array<{
      sourceSkuId: string;
      specs: string;
      priceCny: number | null;
      stock: number | null;
      image: string | null;
      attributes: Record<string, string>;
    }>;
    packageInfo?: {
      weightKg?: number | null;
      lengthCm?: number | null;
      widthCm?: number | null;
      heightCm?: number | null;
    };
  };

  validation: {
    status: 'valid' | 'warning' | 'needs_review' | 'blocked';
    warnings: string[];
    errors: string[];
  };
}
