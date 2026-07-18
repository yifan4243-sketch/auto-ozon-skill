import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

const root = process.cwd();
const alias: Record<string, string> = {};
for (const base of ['apps', 'packages']) discover(path.join(root, base));

export default defineConfig({
  resolve: { alias },
  test: {
    testTimeout: 10_000,
    coverage: {
      provider: 'v8',
      all: true,
      reportsDirectory: 'coverage',
      reporter: ['text', 'json-summary'],
      include: [
        'packages/steps/listing-submit/src/**/*.ts',
        'packages/image-pipeline/src/**/*.ts',
        'packages/job-store/src/**/*.ts',
        'packages/config/src/**/*.ts',
        'packages/control-plane/src/**/*.ts',
        'packages/steps/cost-pricing/src/**/*.ts',
      ],
      exclude: ['**/index.ts', '**/*-cli.ts'],
      thresholds: {
        lines: 70,
        statements: 70,
        functions: 75,
        branches: 65,
        'packages/steps/listing-submit/src/**': { lines: 75, statements: 75, functions: 80, branches: 70 },
        'packages/image-pipeline/src/**': { lines: 80, statements: 80, functions: 80, branches: 65 },
        'packages/job-store/src/**': { lines: 70, statements: 70, functions: 70, branches: 60 },
        'packages/config/src/**': { lines: 75, statements: 75, functions: 75, branches: 55 },
        'packages/control-plane/src/**': { lines: 35, statements: 35, functions: 50, branches: 65 },
        'packages/steps/cost-pricing/src/**': { lines: 85, statements: 85, functions: 90, branches: 70 },
      },
    },
  },
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
