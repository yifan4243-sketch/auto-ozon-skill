import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const destination = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-ozon-pack-'));
try {
  const workspaces = await discover(root);
  for (const workspace of workspaces) {
    const before = new Set(await fs.readdir(destination));
    execute(process.execPath, [pnpmEntrypoint(), 'pack', '--pack-destination', destination], workspace.directory);
    const archive = (await fs.readdir(destination)).find((name) => !before.has(name));
    if (!archive) throw new Error(`${workspace.name}: pack did not create an archive`);
    const listing = execute('tar', ['-tf', path.join(destination, archive)], root);
    if (/(?:^|\/)src\//mu.test(listing)) throw new Error(`${workspace.name}: packed archive contains src/`);
    if (!/(?:^|\/)dist\//mu.test(listing) && workspace.name !== 'ozon-master') throw new Error(`${workspace.name}: packed archive does not contain dist/`);
  }
  process.stdout.write(`verified ${workspaces.length} workspace archives\n`);
} finally {
  await fs.rm(destination, { recursive: true, force: true });
}

function execute(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  return result.stdout;
}
function pnpmEntrypoint() {
  if (!process.env.npm_execpath) throw new Error('npm_execpath is required to run pnpm pack verification.');
  return process.env.npm_execpath;
}
async function discover(rootDirectory) {
  const found = [];
  for (const base of ['apps', 'packages']) await visit(path.join(rootDirectory, base));
  return found;
  async function visit(directory) {
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return; }
    if (entries.some((entry) => entry.isFile() && entry.name === 'package.json')) {
      const manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
      found.push({ directory, name: manifest.name });
    }
    for (const entry of entries) if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'dist') await visit(path.join(directory, entry.name));
  }
}
