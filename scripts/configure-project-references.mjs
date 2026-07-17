import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const workspaces = await discover(root);
const byName = new Map(workspaces.map((workspace) => [workspace.manifest.name, workspace]));
for (const workspace of workspaces) {
  if (workspace.manifest.name === 'ozon-master') continue;
  const manifest = workspace.manifest;
  manifest.main = './dist/index.js';
  manifest.types = './dist/index.d.ts';
  manifest.exports = { '.': { types: './dist/index.d.ts', import: './dist/index.js', default: './dist/index.js' } };
  manifest.files = [...new Set(['dist', ...(manifest.files ?? []).filter((entry) => entry !== 'src')])];
  manifest.scripts = { ...(manifest.scripts ?? {}), build: 'tsc -b' };
  if (manifest.name === '@auto-ozon/cli') {
    manifest.main = './dist/cli.js'; manifest.types = './dist/cli.d.ts';
    manifest.exports = { '.': { types: './dist/cli.d.ts', import: './dist/cli.js', default: './dist/cli.js' } };
    manifest.bin = { 'auto-ozon': './dist/cli.js' };
  }
  const dependencyNames = Object.keys({ ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) });
  const references = dependencyNames.filter((name) => byName.has(name) && name !== 'ozon-master').map((name) => ({
    path: normalize(path.relative(workspace.directory, byName.get(name).directory)),
  })).sort((a, b) => a.path.localeCompare(b.path));
  const optionsPath = normalize(path.relative(workspace.directory, path.join(root, 'tsconfig.options.json')));
  const config = {
    extends: optionsPath,
    compilerOptions: { rootDir: './src', outDir: './dist', tsBuildInfoFile: './dist/.tsbuildinfo' },
    include: ['src/**/*.ts'], references,
  };
  await fs.writeFile(workspace.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.writeFile(path.join(workspace.directory, 'tsconfig.json'), `${JSON.stringify(config, null, 2)}\n`);
}
const references = workspaces.filter((workspace) => workspace.manifest.name !== 'ozon-master')
  .map((workspace) => ({ path: normalize(path.relative(root, workspace.directory)) }))
  .sort((a, b) => a.path.localeCompare(b.path));
await fs.writeFile(path.join(root, 'tsconfig.json'), `${JSON.stringify({ files: [], references }, null, 2)}\n`);

async function discover(rootDirectory) {
  const found = [];
  for (const base of ['apps', 'packages']) await visit(path.join(rootDirectory, base));
  return found;
  async function visit(directory) {
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return; }
    const manifestPath = path.join(directory, 'package.json');
    if (entries.some((entry) => entry.isFile() && entry.name === 'package.json')) {
      found.push({ directory, manifestPath, manifest: JSON.parse(await fs.readFile(manifestPath, 'utf8')) });
    }
    for (const entry of entries) if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'dist') await visit(path.join(directory, entry.name));
  }
}
function normalize(value) { return value.replaceAll('\\', '/'); }
