import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const required = ['bin/ozon-master.mjs', 'release-manifest.json', 'README.md', 'LICENSE'];
for (const relative of required) {
  if (!fs.existsSync(path.join(packageDirectory, relative))) {
    throw new Error(`ozon-master package file is missing: ${relative}`);
  }
}

const manifest = JSON.parse(fs.readFileSync(path.join(packageDirectory, 'release-manifest.json'), 'utf8'));
if (manifest.schema_version !== 1 || typeof manifest.repository_url !== 'string') {
  throw new Error('ozon-master release-manifest.json is invalid.');
}

// Ordinary development packs intentionally retain the tracked `unreleased`
// manifest. Strict tag/commit verification belongs to release:prepare and
// release:verify and is never an implicit prepack side effect.
