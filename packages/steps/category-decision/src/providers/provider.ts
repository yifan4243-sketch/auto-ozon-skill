import type { CanonicalProductV2, CategoryDecisionV1 } from '@auto-ozon/contracts';

export interface CategoryDecisionProvider {
  load(product?: CanonicalProductV2): Promise<CategoryDecisionV1>;
}

export type CategoryDecisionResolver = (
  product: CanonicalProductV2,
) => Promise<CategoryDecisionV1>;

export class AgentDecisionProvider implements CategoryDecisionProvider {
  constructor(private readonly resolver: CategoryDecisionResolver) {}

  load(product?: CanonicalProductV2): Promise<CategoryDecisionV1> {
    if (!product) {
      return Promise.reject(new Error('AgentDecisionProvider requires CanonicalProductV2.'));
    }
    return this.resolver(product);
  }
}
