import path from 'node:path';
import { defineConfig } from 'vitest/config';

const root = path.resolve(import.meta.dirname);
const aliases: Record<string, string> = {
  '@auto-ozon/contracts': 'packages/contracts/src/index.ts',
  '@auto-ozon/adapters-1688': 'packages/adapters-1688/src/index.ts',
  '@auto-ozon/adapters-ozon': 'packages/adapters-ozon/src/index.ts',
  '@auto-ozon/artifact-store': 'packages/artifact-store/src/index.ts',
  '@auto-ozon/core': 'packages/core/src/index.ts',
  '@auto-ozon/config': 'packages/config/src/index.ts',
  '@auto-ozon/category-intelligence': 'packages/category-intelligence/src/index.ts',
  '@auto-ozon/transformer': 'packages/transformer/src/index.ts',
  '@auto-ozon/workflows': 'packages/workflows/src/index.ts',
  '@auto-ozon/step-source-1688': 'packages/steps/source-1688/src/index.ts',
  '@auto-ozon/step-canonicalize-product': 'packages/steps/canonicalize-product/src/index.ts',
  '@auto-ozon/step-category-decision': 'packages/steps/category-decision/src/index.ts',
  '@auto-ozon/step-category-attributes': 'packages/steps/category-attributes/src/index.ts',
  '@auto-ozon/step-attribute-mapping': 'packages/steps/attribute-mapping/src/index.ts',
  '@auto-ozon/step-draft-generation': 'packages/steps/draft-generation/src/index.ts',
  '@auto-ozon/step-listing-payload': 'packages/steps/listing-payload/src/index.ts',
  '@auto-ozon/step-ozon-publish': 'packages/steps/ozon-publish/src/index.ts',
};

export default defineConfig({
  resolve: { alias: Object.fromEntries(Object.entries(aliases).map(([key, value]) => [key, path.join(root, value)])) },
});
