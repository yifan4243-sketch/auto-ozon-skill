import type { SourcingResult } from '../../../contracts/src/sourcing-result.js';
import type { ImageSearchResult } from '../engine/commands/image-search.js';
import type { OfferBatchResult } from '../engine/commands/offers.js';
import { offerToCanonical } from './offer-to-canonical.js';

export function imageSearchToSourcingResult(input: {
  imagePath: string;
  imageSearch: ImageSearchResult;
  details: OfferBatchResult;
}): SourcingResult {
  return {
    mode: 'image',
    imagePath: input.imagePath,
    offerIds: input.details.offerIds,
    total: input.details.total,
    success: input.details.success,
    failed: input.details.failed,
    items: input.details.offers.map((offer) => offerToCanonical(offer, 'image')),
    raw: {
      imageId: input.imageSearch.imageId,
      total: input.imageSearch.total,
      offers: input.imageSearch.offers,
      details: input.details,
    },
    failures: input.details.failures.map((failure) => ({
      offerId: failure.offerId,
      code: failure.code,
      message: failure.message,
      recoverable: failure.code !== 'BAD_INPUT',
    })),
  };
}
