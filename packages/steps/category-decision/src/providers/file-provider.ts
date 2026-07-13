import fs from 'node:fs/promises';
import path from 'node:path';
import type { CanonicalProductV2, CategoryDecisionV1 } from '@auto-ozon/contracts';
import { resolveRepoRoot } from '@auto-ozon/artifact-store';
import type { CategoryDecisionProvider } from './provider.js';

export class FileDecisionProvider implements CategoryDecisionProvider {
  constructor(private readonly filePath: string) {}

  async load(_product?: CanonicalProductV2): Promise<CategoryDecisionV1> {
    const resolved = resolveInputPath(this.filePath);
    const raw = await fs.readFile(resolved, 'utf8');
    return JSON.parse(raw) as CategoryDecisionV1;
  }
}

function resolveInputPath(filePath: string): string {
  if (path.isAbsolute(filePath)) return filePath;

  return path.join(resolveRepoRoot(), filePath);
}
