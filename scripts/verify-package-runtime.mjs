import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const manifests = [];
for (const root of ['packages', 'apps']) await collect(root);
for (const manifestPath of manifests.sort()) {
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (!manifest.name) continue;
  const entry = manifest.exports?.['.']?.import ?? manifest.main;
  if (!entry) continue;
  if (!String(entry).replace(/^\.\//, '').startsWith('dist/')) throw new Error(`${manifest.name} runtime entry is not in dist: ${entry}`);
  const absolute = path.resolve(path.dirname(manifestPath), entry);
  await fs.access(absolute);
  await import(pathToFileURL(absolute).href);
}

async function collect(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(full);
    else if (entry.name === 'package.json') manifests.push(full);
  }
}
