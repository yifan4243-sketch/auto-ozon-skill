import type { CanonicalProduct } from './canonical-product.js';

export interface SourcingResult {
  mode: 'keyword' | 'image' | 'offers' | 'similar';
  query?: string;
  imagePath?: string;
  offerIds?: string[];
  total: number;
  success: number;
  failed: number;
  items: CanonicalProduct[];
  raw?: unknown;
  failures: Array<{
    offerId?: string;
    code: string;
    message: string;
    recoverable: boolean;
  }>;
}
