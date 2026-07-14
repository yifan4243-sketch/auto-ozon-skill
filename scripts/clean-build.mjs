import fs from 'node:fs/promises';
import path from 'node:path';

const roots = ['dist', 'apps', 'packages'];
for (const root of roots) {
  if (root === 'dist') { await fs.rm(root, { recursive: true, force: true }); continue; }
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const first = path.join(root, entry.name);
    await fs.rm(path.join(first, 'dist'), { recursive: true, force: true });
    if (root === 'packages' && entry.name === 'steps') {
      for (const step of await fs.readdir(first, { withFileTypes: true })) {
        if (step.isDirectory()) await fs.rm(path.join(first, step.name, 'dist'), { recursive: true, force: true });
      }
    }
  }
}
