import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

export const PRODUCT_WORKSPACE_DIRECTORIES = {
  source1688: '1688_data',
  canonicalV2: '1688_data_v2',
  ozonCategory: 'ozon_category',
} as const;

export type ProductWorkspaceStage =
  | 'source_1688'
  | 'canonical_v2'
  | 'category_decision'
  | 'category_attributes';

export type ProductWorkspaceStageStatus =
  | 'not_started'
  | 'completed'
  | 'needs_review'
  | 'blocked'
  | 'failed';

export type ProductWorkspaceArtifact =
  | 'source_1688'
  | 'source_failure'
  | 'canonical_v2'
  | 'integrity_report'
  | 'category_decision'
  | 'category_attributes';

export interface ProductWorkspaceManifestV1 {
  schema_version: 1;
  offer_id: string;
  updated_at: string;
  collection?: {
    command: string;
    method: string;
    search_term: string | null;
    seed_offer_id: string | null;
    collected_at: string;
  };
  stages: Record<ProductWorkspaceStage, ProductWorkspaceStageStatus>;
  artifact_paths: Record<ProductWorkspaceArtifact, string>;
}

export interface ProductWorkspacePaths {
  productsRoot: string;
  productDirectory: string;
  manifest: string;
  directories: {
    source1688: string;
    canonicalV2: string;
    ozonCategory: string;
  };
  artifacts: Record<ProductWorkspaceArtifact, string>;
}

export interface ProductWorkspaceManifestUpdate {
  collection?: ProductWorkspaceManifestV1['collection'];
  stages?: Partial<Record<ProductWorkspaceStage, ProductWorkspaceStageStatus>>;
  updatedAt?: string;
}

export function resolveProductsRoot(productsDir?: string): string {
  const repoRoot = resolveRepoRoot();
  if (!productsDir) return path.join(repoRoot, 'data', 'products');
  return path.isAbsolute(productsDir)
    ? path.normalize(productsDir)
    : path.resolve(repoRoot, productsDir);
}

export function getProductWorkspacePaths(
  offerId: string,
  productsDir?: string,
): ProductWorkspacePaths {
  assertOfferId(offerId);
  const productsRoot = resolveProductsRoot(productsDir);
  const productDirectory = path.join(productsRoot, offerId);
  const directories = {
    source1688: path.join(productDirectory, PRODUCT_WORKSPACE_DIRECTORIES.source1688),
    canonicalV2: path.join(productDirectory, PRODUCT_WORKSPACE_DIRECTORIES.canonicalV2),
    ozonCategory: path.join(productDirectory, PRODUCT_WORKSPACE_DIRECTORIES.ozonCategory),
  };
  return {
    productsRoot,
    productDirectory,
    manifest: path.join(productDirectory, 'manifest.json'),
    directories,
    artifacts: {
      source_1688: path.join(directories.source1688, 'source.json'),
      source_failure: path.join(directories.source1688, 'failure.json'),
      canonical_v2: path.join(directories.canonicalV2, 'product.json'),
      integrity_report: path.join(directories.canonicalV2, 'integrity-report.json'),
      category_decision: path.join(directories.ozonCategory, 'category-decision-v1.json'),
      category_attributes: path.join(directories.ozonCategory, 'category-attributes-v1.json'),
    },
  };
}

export async function ensureProductWorkspace(
  offerId: string,
  productsDir?: string,
): Promise<ProductWorkspacePaths> {
  const paths = getProductWorkspacePaths(offerId, productsDir);
  await Promise.all(
    Object.values(paths.directories).map((directory) =>
      fs.mkdir(directory, { recursive: true }),
    ),
  );
  try {
    await fs.access(paths.manifest);
  } catch {
    await writeJsonAtomic(paths.manifest, createManifest(offerId, paths));
  }
  return paths;
}

export async function writeProductWorkspaceArtifact(
  offerId: string,
  artifact: ProductWorkspaceArtifact,
  value: unknown,
  options: {
    productsDir?: string;
    manifest?: ProductWorkspaceManifestUpdate;
  } = {},
): Promise<string> {
  const paths = await ensureProductWorkspace(offerId, options.productsDir);
  const artifactPath = paths.artifacts[artifact];
  await writeJsonAtomic(artifactPath, value);
  await updateProductWorkspaceManifest(offerId, options.productsDir, options.manifest);
  return artifactPath;
}

export async function updateProductWorkspaceManifest(
  offerId: string,
  productsDir?: string,
  update: ProductWorkspaceManifestUpdate = {},
): Promise<ProductWorkspaceManifestV1> {
  const paths = await ensureProductWorkspace(offerId, productsDir);
  const existing = await readManifest(paths.manifest, offerId, paths);
  const manifest: ProductWorkspaceManifestV1 = {
    ...existing,
    updated_at: update.updatedAt ?? new Date().toISOString(),
    ...(update.collection ? { collection: update.collection } : {}),
    stages: {
      ...existing.stages,
      ...update.stages,
    },
  };
  await writeJsonAtomic(paths.manifest, manifest);
  return manifest;
}

function createManifest(
  offerId: string,
  paths: ProductWorkspacePaths,
): ProductWorkspaceManifestV1 {
  return {
    schema_version: 1,
    offer_id: offerId,
    updated_at: new Date().toISOString(),
    stages: {
      source_1688: 'not_started',
      canonical_v2: 'not_started',
      category_decision: 'not_started',
      category_attributes: 'not_started',
    },
    artifact_paths: Object.fromEntries(
      Object.entries(paths.artifacts).map(([key, value]) => [
        key,
        path.relative(paths.productDirectory, value).replaceAll('\\', '/'),
      ]),
    ) as Record<ProductWorkspaceArtifact, string>,
  };
}

async function readManifest(
  manifestPath: string,
  offerId: string,
  paths: ProductWorkspacePaths,
): Promise<ProductWorkspaceManifestV1> {
  try {
    const value = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Partial<ProductWorkspaceManifestV1>;
    if (value.schema_version === 1 && value.offer_id === offerId && value.stages) {
      return {
        ...createManifest(offerId, paths),
        ...value,
        stages: {
          ...createManifest(offerId, paths).stages,
          ...value.stages,
        },
        artifact_paths: createManifest(offerId, paths).artifact_paths,
      };
    }
  } catch {
    // Replace missing or invalid manifests with the canonical workspace shape.
  }
  return createManifest(offerId, paths);
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

function assertOfferId(offerId: string): void {
  if (!/^\d+$/.test(offerId) || offerId === '0') {
    throw new Error(`Invalid 1688 offer ID for product workspace: ${offerId}`);
  }
}

function resolveRepoRoot(): string {
  let current = process.cwd();
  while (true) {
    if (fsSync.existsSync(path.join(current, 'pnpm-workspace.yaml'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return process.cwd();
    current = parent;
  }
}
