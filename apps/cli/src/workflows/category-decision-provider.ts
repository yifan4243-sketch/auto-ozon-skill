import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import type { CategoryDecisionV1 } from '../../../../packages/contracts/src/category-decision.js';

export interface CategoryDecisionProvider {
  load(): Promise<CategoryDecisionV1>;
}

export class FileDecisionProvider implements CategoryDecisionProvider {
  constructor(private readonly filePath: string) {}

  async load(): Promise<CategoryDecisionV1> {
    const resolved = resolveInputPath(this.filePath);
    const raw = await fs.readFile(resolved, 'utf8');
    return JSON.parse(raw) as CategoryDecisionV1;
  }
}

function resolveInputPath(filePath: string): string {
  if (path.isAbsolute(filePath)) return filePath;

  const repoRoot = resolveRepoRoot();

  // Try relative to repo root first, then cwd
  const candidates = [
    path.join(repoRoot, filePath),
    path.resolve(process.cwd(), filePath),
  ];
  for (const candidate of candidates) {
    if (fsSync.existsSync(candidate)) return candidate;
  }
  // Default to repo-root-relative
  return path.join(repoRoot, filePath);
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

// Future: AgentDecisionProvider — invokes the AI Agent to produce a decision on the fly.
