import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const placeholder = {
  schema_version: 1,
  repository_url: 'https://github.com/yifan4243-sketch/auto-ozon-skill.git',
  git_ref: 'unreleased',
  commit: null,
  tree: null,
  tree_sha256: null,
};

fs.writeFileSync(
  path.join(packageDirectory, 'release-manifest.json'),
  `${JSON.stringify(placeholder, null, 2)}\n`,
  'utf8',
);
