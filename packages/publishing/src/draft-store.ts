import type { CategoryAttributesV1 } from '../../contracts/src/category-attributes.js';
import type { CategoryDecisionV1 } from '../../contracts/src/category-decision.js';
import type { ProductWorkspaceStageStatus } from '../../core/src/product-workspace.js';
import { writeProductWorkspaceArtifact } from '../../core/src/product-workspace.js';

export interface ProductArtifactStoreOptions {
  offerId: string;
  productsDir?: string;
}

export interface StoredCategoryAttributesGroupV1 {
  group_ids: string[];
  category?: {
    description_category_id: number;
    type_id: number;
    category_path_zh?: string[];
  };
  attributes_schema: CategoryAttributesV1;
}

export async function saveCategoryDecisionSnapshot(
  options: ProductArtifactStoreOptions,
  decision: CategoryDecisionV1,
): Promise<string> {
  return writeProductWorkspaceArtifact(
    options.offerId,
    'category_decision',
    decision,
    {
      productsDir: options.productsDir,
      manifest: {
        stages: {
          category_decision:
            decision.status === 'decided' ? 'completed' : decision.status,
        },
      },
    },
  );
}

export async function saveCategoryAttributesSnapshot(
  options: ProductArtifactStoreOptions,
  groups: StoredCategoryAttributesGroupV1[],
  status: ProductWorkspaceStageStatus = 'completed',
): Promise<string> {
  return writeProductWorkspaceArtifact(
    options.offerId,
    'category_attributes',
    groups,
    {
      productsDir: options.productsDir,
      manifest: { stages: { category_attributes: status } },
    },
  );
}

export async function saveOzonDraft(
  options: ProductArtifactStoreOptions,
  draft: unknown,
  status: ProductWorkspaceStageStatus = 'needs_review',
): Promise<string> {
  return writeProductWorkspaceArtifact(options.offerId, 'ozon_draft', draft, {
    productsDir: options.productsDir,
    manifest: { stages: { ozon_draft: status } },
  });
}

export async function saveOzonDraftValidation(
  options: ProductArtifactStoreOptions,
  validation: unknown,
  status: ProductWorkspaceStageStatus,
): Promise<string> {
  return writeProductWorkspaceArtifact(
    options.offerId,
    'draft_validation',
    validation,
    {
      productsDir: options.productsDir,
      manifest: { stages: { ozon_draft: status } },
    },
  );
}

export async function saveOzonUploadRequest(
  options: ProductArtifactStoreOptions,
  request: unknown,
): Promise<string> {
  return writeProductWorkspaceArtifact(
    options.offerId,
    'upload_request',
    request,
    {
      productsDir: options.productsDir,
      manifest: { stages: { ozon_upload: 'needs_review' } },
    },
  );
}

export async function saveOzonUploadResult(
  options: ProductArtifactStoreOptions,
  result: unknown,
  succeeded: boolean,
): Promise<string> {
  return writeProductWorkspaceArtifact(
    options.offerId,
    'upload_result',
    result,
    {
      productsDir: options.productsDir,
      manifest: {
        stages: { ozon_upload: succeeded ? 'completed' : 'failed' },
      },
    },
  );
}
