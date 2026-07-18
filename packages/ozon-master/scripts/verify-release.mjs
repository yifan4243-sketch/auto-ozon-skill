import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(packageDirectory, '..', '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(packageDirectory, 'package.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(packageDirectory, 'release-manifest.json'), 'utf8'));
const expectedTag = process.env.OZON_MASTER_RELEASE_TAG ?? `v${String(packageJson.version).replace('-rc.', '-rc')}`;
const commit = git(['rev-parse', 'HEAD']);
const tagCommit = git(['rev-parse', '--verify', `${expectedTag}^{commit}`]);
if (tagCommit !== commit) throw new Error(`Release tag ${expectedTag} does not point to HEAD.`);
if (manifest.git_ref !== expectedTag || manifest.commit !== commit) throw new Error('Release manifest tag/commit binding is invalid.');
const tree = git(['rev-parse', 'HEAD^{tree}']);
if (manifest.tree !== tree) throw new Error('Release manifest tree binding is invalid.');
const archive = execFileSync('git', ['archive', '--format=tar', 'HEAD'], { cwd: repositoryRoot, maxBuffer: 512 * 1024 * 1024 });
const treeSha256 = crypto.createHash('sha256').update(archive).digest('hex');
if (manifest.tree_sha256 !== treeSha256) throw new Error('Release manifest archive SHA-256 is invalid.');

function git(args) {
  return execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' }).trim();
}
