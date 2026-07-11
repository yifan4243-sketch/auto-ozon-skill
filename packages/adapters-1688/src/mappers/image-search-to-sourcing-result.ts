import type { SourcingResult } from '../../../contracts/src/sourcing-result.js';
import type { ImageSearchResult } from '../engine/commands/image-search.js';
import type { OfferBatchResult } from '../engine/commands/offers.js';
import { offerToCanonical } from './offer-to-canonical.js';
import { sanitizeOfferBatchResult } from '../v2/offer-result-codec.js';

export function imageSearchToSourcingResult(input: {
  imagePath: string;
  imageSearch: ImageSearchResult;
  details: OfferBatchResult;
}): SourcingResult {
  const details = sanitizeOfferBatchResult(input.details);
  return {
    mode: 'image',
    imagePath: input.imagePath,
    offerIds: details.offerIds,
    total: details.total,
    success: details.success,
    failed: details.failed,
    items: details.offers.map((offer) => offerToCanonical(offer, 'image')),
    raw: details,
    failures: details.failures.map((failure) => ({
      offerId: failure.offerId,
      code: failure.code,
      message: failure.message,
      recoverable: failure.code !== 'BAD_INPUT',
    })),
  };
}
