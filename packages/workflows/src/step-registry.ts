import type { WorkflowStepName } from '@auto-ozon/contracts';

export const LISTING_PREPARATION_ORDER: readonly WorkflowStepName[] = [
  'source-1688',
  'canonicalize-product',
  'category-decision',
  'category-attributes',
  'attribute-mapping',
  'draft-generation',
  'listing-payload',
  'ozon-publish',
];

export function shouldRunStep(
  step: WorkflowStepName,
  options: {
    startFrom?: WorkflowStepName;
    stopAfter?: WorkflowStepName;
  },
): boolean {
  const current = LISTING_PREPARATION_ORDER.indexOf(step);
  const start = options.startFrom
    ? LISTING_PREPARATION_ORDER.indexOf(options.startFrom)
    : 0;
  const stop = options.stopAfter
    ? LISTING_PREPARATION_ORDER.indexOf(options.stopAfter)
    : LISTING_PREPARATION_ORDER.length - 1;
  return current >= start && current <= stop;
}
