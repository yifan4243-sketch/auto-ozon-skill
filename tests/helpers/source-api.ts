import type {
  OffersInput,
  SearchImageInput,
  SearchKeywordInput,
  SimilarInput,
} from '../../packages/adapters-1688/src/client.js';
import {
  runOfflineNormalizeCommand,
  runSourceCommand,
} from '../../packages/workflows/src/index.js';

export const search1688ByKeyword = (input: SearchKeywordInput) =>
  runSourceCommand({ source: { mode: 'keyword', ...input }, schema_version: 1 });

export const search1688ByKeywordV2 = (
  input: SearchKeywordInput & { productsDir?: string },
) => runSourceCommand({
  source: { mode: 'keyword', ...input },
  schema_version: 2,
  products_dir: input.productsDir,
});

export const search1688ByImage = (input: SearchImageInput) =>
  runSourceCommand({ source: { mode: 'image', ...input }, schema_version: 1 });

export const search1688ByImageV2 = (
  input: SearchImageInput & { productsDir?: string },
) => runSourceCommand({
  source: { mode: 'image', ...input },
  schema_version: 2,
  products_dir: input.productsDir,
});

export const get1688Offers = (input: OffersInput) =>
  runSourceCommand({ source: { mode: 'offers', ...input }, schema_version: 1 });

export const get1688OffersV2 = (input: OffersInput & { productsDir?: string }) =>
  runSourceCommand({
    source: { mode: 'offers', ...input },
    schema_version: 2,
    products_dir: input.productsDir,
  });

export const get1688Similar = (input: SimilarInput) =>
  runSourceCommand({ source: { mode: 'similar', ...input }, schema_version: 1 });

export const get1688SimilarV2 = (
  input: SimilarInput & { productsDir?: string },
) => runSourceCommand({
  source: { mode: 'similar', ...input },
  schema_version: 2,
  products_dir: input.productsDir,
});

export const normalizeV2Offline = (input: {
  inputPath: string;
  method?: 'keyword' | 'image' | 'offers' | 'similar';
  searchTerm?: string | null;
  seedOfferId?: string | null;
  productsDir?: string;
}) => runOfflineNormalizeCommand({
  input_path: input.inputPath,
  method: input.method ?? 'offers',
  search_term: input.searchTerm,
  seed_offer_id: input.seedOfferId,
  products_dir: input.productsDir,
});
