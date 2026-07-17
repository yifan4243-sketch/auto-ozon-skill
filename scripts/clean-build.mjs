import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const workspaceRoots = ['apps', 'packages'];
const directories = [];
for (const workspaceRoot of workspaceRoots) await collect(path.join(root, workspaceRoot));
await Promise.all(directories.map((directory) => fs.rm(directory, { recursive: true, force: true })));
await fs.rm(path.join(root, 'dist'), { recursive: true, force: true });

async function collect(directory) {
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue;
    const child = path.join(directory, entry.name);
    if (entry.name === 'dist') directories.push(child);
    else await collect(child);
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.tsbuildinfo')) await fs.rm(path.join(directory, entry.name), { force: true });
  }
}
