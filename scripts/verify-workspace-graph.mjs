import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const workspaces = await discover(root);
const byName = new Map(workspaces.map((workspace) => [workspace.manifest.name, workspace]));
const graph = new Map();
const violations = [];
for (const workspace of workspaces) {
  if (workspace.manifest.name === 'ozon-master') continue;
  const declared = new Set(Object.keys({ ...(workspace.manifest.dependencies ?? {}), ...(workspace.manifest.devDependencies ?? {}) }));
  const internal = [...declared].filter((name) => byName.has(name));
  graph.set(workspace.manifest.name, internal);
  for (const source of await sourceFiles(path.join(workspace.directory, 'src'))) {
    const text = await fs.readFile(source, 'utf8');
    for (const specifier of imports(text)) {
      if (specifier.startsWith('.') || specifier.startsWith('node:')) continue;
      const packageName = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
      if (!declared.has(packageName)) violations.push(`${workspace.manifest.name}: undeclared ${packageName} in ${normalize(path.relative(root, source))}`);
    }
  }
}
const visiting = new Set(); const visited = new Set();
for (const name of graph.keys()) visit(name, []);
if (violations.length) throw new Error(`Workspace dependency verification failed:\n${violations.join('\n')}`);
process.stdout.write(`verified ${graph.size} workspace dependency graphs\n`);

function visit(name, ancestry) {
  if (visiting.has(name)) { violations.push(`workspace cycle: ${[...ancestry, name].join(' -> ')}`); return; }
  if (visited.has(name)) return;
  visiting.add(name);
  for (const dependency of graph.get(name) ?? []) visit(dependency, [...ancestry, name]);
  visiting.delete(name); visited.add(name);
}
function imports(text) {
  const found = [];
  const pattern = /(?:from\s+|import\s*\(|import\s+|export\s+[^;]*?from\s+|require\s*\()\s*['"]([^'"]+)['"]/gu;
  for (const match of text.matchAll(pattern)) if (match[1]) found.push(match[1]);
  return found;
}
async function sourceFiles(directory) {
  const files = [];
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return files; }
  for (const entry of entries) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(child));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(child);
  }
  return files;
}
async function discover(rootDirectory) {
  const found = [];
  for (const base of ['apps', 'packages']) await visitDirectory(path.join(rootDirectory, base));
  return found;
  async function visitDirectory(directory) {
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return; }
    if (entries.some((entry) => entry.isFile() && entry.name === 'package.json')) {
      found.push({ directory, manifest: JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8')) });
    }
    for (const entry of entries) if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'dist') await visitDirectory(path.join(directory, entry.name));
  }
}
function normalize(value) { return value.replaceAll('\\', '/'); }
