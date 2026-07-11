import type { SourcingResult } from '../../../contracts/src/sourcing-result.js';
import type { SearchResult } from '../engine/commands/search.js';
import type { OfferBatchResult } from '../engine/commands/offers.js';
import { offerToCanonical } from './offer-to-canonical.js';
import { sanitizeOfferBatchResult } from '../v2/offer-result-codec.js';

export function searchToSourcingResult(input: {
  query: string;
  search: SearchResult;
  details: OfferBatchResult;
}): SourcingResult {
  const details = sanitizeOfferBatchResult(input.details);
  return {
    mode: 'keyword',
    query: input.query,
    offerIds: details.offerIds,
    total: details.total,
    success: details.success,
    failed: details.failed,
    items: details.offers.map((offer) => offerToCanonical(offer, 'keyword')),
    raw: details,
    failures: details.failures.map((failure) => ({
      offerId: failure.offerId,
      code: failure.code,
      message: failure.message,
      recoverable: failure.code !== 'BAD_INPUT',
    })),
  };
}
