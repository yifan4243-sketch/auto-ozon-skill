import fs from 'node:fs';
import path from 'node:path';

export function resolveRepoRoot(startDirectory = process.cwd()): string {
  let current = path.resolve(startDirectory);
  while (true) {
    if (fs.existsSync(path.join(current, 'pnpm-workspace.yaml'))) return current;
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Unable to locate repository root from ${startDirectory}.`);
    }
    current = parent;
  }
}
