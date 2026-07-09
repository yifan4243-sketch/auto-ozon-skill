import type { SourcingResult } from '../../../contracts/src/sourcing-result.js';
import type { SearchResult } from '../engine/commands/search.js';
import type { OfferBatchResult } from '../engine/commands/offers.js';
import { offerToCanonical } from './offer-to-canonical.js';

export function searchToSourcingResult(input: {
  query: string;
  search: SearchResult;
  details: OfferBatchResult;
}): SourcingResult {
  return {
    mode: 'keyword',
    query: input.query,
    offerIds: input.details.offerIds,
    total: input.details.total,
    success: input.details.success,
    failed: input.details.failed,
    items: input.details.offers.map((offer) => offerToCanonical(offer, 'keyword')),
    raw: {
      keyword: input.search.keyword,
      sort: input.search.sort,
      filters: input.search.filters,
      totalBeforeFilter: input.search.totalBeforeFilter,
      total: input.search.total,
      offers: input.search.offers,
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
