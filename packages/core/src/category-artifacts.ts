import type { CategoryAttributesV1, CategoryDecisionV1 } from '@auto-ozon/contracts';
import type { ProductWorkspaceStageStatus } from './product-workspace.js';
import { writeProductWorkspaceArtifact } from './product-workspace.js';

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
  return writeProductWorkspaceArtifact(options.offerId, 'category_decision', decision, {
    productsDir: options.productsDir,
    manifest: {
      stages: {
        category_decision: decision.status === 'decided' ? 'completed' : decision.status,
      },
    },
  });
}

export async function saveCategoryAttributesSnapshot(
  options: ProductArtifactStoreOptions,
  groups: StoredCategoryAttributesGroupV1[],
  status: ProductWorkspaceStageStatus = 'completed',
): Promise<string> {
  return writeProductWorkspaceArtifact(options.offerId, 'category_attributes', groups, {
    productsDir: options.productsDir,
    manifest: { stages: { category_attributes: status } },
  });
}
