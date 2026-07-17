import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const packages = await discover(root);
for (const item of packages) {
  const manifest = JSON.parse(await fs.readFile(item.manifestPath, 'utf8'));
  if (manifest.name === 'ozon-master') continue;
  if (!manifest.main?.startsWith('./dist/') || !manifest.types?.startsWith('./dist/')) throw new Error(`${manifest.name}: main/types must point to dist`);
  const main = path.resolve(item.directory, manifest.main);
  const types = path.resolve(item.directory, manifest.types);
  await fs.access(main); await fs.access(types);
  await import(pathToFileURL(main).href);
  const exportTargets = flatten(manifest.exports ?? {});
  if (exportTargets.some((target) => target.includes('/src/') || (target.endsWith('.ts') && !target.endsWith('.d.ts')))) throw new Error(`${manifest.name}: runtime exports source TypeScript`);
}
function flatten(value) {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(flatten);
}
process.stdout.write(`verified ${packages.length - 1} built TypeScript workspaces\n`);

async function discover(rootDirectory) {
  const found = [];
  for (const base of ['apps', 'packages']) await visit(path.join(rootDirectory, base));
  return found;
  async function visit(directory) {
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return; }
    if (entries.some((entry) => entry.isFile() && entry.name === 'package.json')) found.push({ directory, manifestPath: path.join(directory, 'package.json') });
    for (const entry of entries) if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'dist') await visit(path.join(directory, entry.name));
  }
}
