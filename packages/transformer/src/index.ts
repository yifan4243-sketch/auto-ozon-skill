// Compatibility facade. New code imports @auto-ozon/step-draft-generation.
export { runDraftGeneration } from '@auto-ozon/step-draft-generation';
/** @deprecated Import canonicalization utilities from @auto-ozon/step-canonicalize-product. */
export {
  parseSkuSpec,
  normalizeRawWeight,
  normalizePositivePackageValue,
  validateSourceSkuIds,
  assembleCanonicalSkus,
  compareSkuFields,
  analyzeSkuVariants,
  summarizeCanonicalV2Run,
  checkCanonicalV2Integrity,
} from '@auto-ozon/step-canonicalize-product';
/** @deprecated Use runDraftGenerationV2 for new workflows. */
export { buildOzonProductDraft } from '@auto-ozon/step-draft-generation/legacy';
