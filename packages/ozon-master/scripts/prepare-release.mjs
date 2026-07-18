import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(packageDirectory, '..', '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(packageDirectory, 'package.json'), 'utf8'));
const dirty = git(['status', '--porcelain']);
if (dirty) throw new Error('ozon-master release packaging requires a clean Git worktree.');
const commit = git(['rev-parse', 'HEAD']);
const tree = git(['rev-parse', 'HEAD^{tree}']);
const gitRef = process.env.OZON_MASTER_RELEASE_TAG
  ?? `v${String(packageJson.version).replace('-rc.', '-rc')}`;
const tagCommit = git(['rev-parse', `${gitRef}^{commit}`]);
if (tagCommit !== commit) throw new Error(`Release tag ${gitRef} does not point to HEAD.`);
const archive = execFileSync('git', ['archive', '--format=tar', 'HEAD'], { cwd: repositoryRoot, maxBuffer: 512 * 1024 * 1024 });
const manifest = {
  schema_version: 1,
  repository_url: 'https://github.com/yifan4243-sketch/auto-ozon-skill.git',
  git_ref: gitRef,
  commit,
  tree,
  tree_sha256: crypto.createHash('sha256').update(archive).digest('hex'),
};
fs.writeFileSync(
  path.join(packageDirectory, 'release-manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8',
);

function git(args) {
  return execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' }).trim();
}
