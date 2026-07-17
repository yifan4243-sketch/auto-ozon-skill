import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

const root = process.cwd();
const alias: Record<string, string> = {};
for (const base of ['apps', 'packages']) discover(path.join(root, base));

export default defineConfig({
  resolve: { alias },
  test: { testTimeout: 10_000 },
});

function discover(directory: string): void {
  if (!fs.existsSync(directory)) return;
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const manifestPath = path.join(directory, 'package.json');
  if (fs.existsSync(manifestPath) && fs.existsSync(path.join(directory, 'src', 'index.ts'))) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { name?: string };
    if (manifest.name?.startsWith('@auto-ozon/')) alias[manifest.name] = path.join(directory, 'src', 'index.ts');
  }
  for (const entry of entries) if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'dist') discover(path.join(directory, entry.name));
}
