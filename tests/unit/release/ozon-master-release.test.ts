import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
const sourceScripts = path.resolve('packages/ozon-master/scripts');

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('ozon-master package and release separation', () => {
  it('allows ordinary package preparation without a release tag and without worktree pollution', () => {
    const root = fixtureRepository();
    const before = git(root, ['status', '--porcelain']);
    runNode(root, 'prepare-package.mjs');
    expect(git(root, ['status', '--porcelain'])).toBe(before);
  });

  it('rejects strict release preparation when the version tag is missing', () => {
    const root = fixtureRepository();
    expect(() => runNode(root, 'prepare-release.mjs')).toThrow(/Command failed/u);
  });

  it('rejects a release tag that points to a different commit', () => {
    const root = fixtureRepository();
    git(root, ['tag', 'v1.0.0-rc1']);
    fs.writeFileSync(path.join(root, 'change.txt'), 'second commit\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'second']);
    expect(() => runNode(root, 'prepare-release.mjs')).toThrow(/Command failed|does not point to HEAD/u);
  });

  it('prepares and verifies a clean commit with the correct tag', () => {
    const root = fixtureRepository();
    git(root, ['tag', 'v1.0.0-rc1']);
    runNode(root, 'prepare-release.mjs');
    runNode(root, 'verify-release.mjs');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'packages/ozon-master/release-manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ git_ref: 'v1.0.0-rc1', commit: git(root, ['rev-parse', 'HEAD']) });
    runNode(root, 'reset-release-manifest.mjs');
    expect(git(root, ['status', '--porcelain'])).toBe('');
  });
});

function fixtureRepository(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ozon-master-release-test-'));
  roots.push(root);
  const packageDirectory = path.join(root, 'packages/ozon-master');
  fs.mkdirSync(path.join(packageDirectory, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(packageDirectory, 'bin'), { recursive: true });
  for (const name of ['prepare-package.mjs', 'prepare-release.mjs', 'verify-release.mjs', 'reset-release-manifest.mjs']) {
    fs.copyFileSync(path.join(sourceScripts, name), path.join(packageDirectory, 'scripts', name));
  }
  fs.writeFileSync(path.join(packageDirectory, 'package.json'), JSON.stringify({ name: 'ozon-master', version: '1.0.0-rc.1' }));
  fs.writeFileSync(path.join(packageDirectory, 'release-manifest.json'), `${JSON.stringify({
    schema_version: 1,
    repository_url: 'https://github.com/yifan4243-sketch/auto-ozon-skill.git',
    git_ref: 'unreleased', commit: null, tree: null, tree_sha256: null,
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(packageDirectory, 'bin/ozon-master.mjs'), '#!/usr/bin/env node\n');
  fs.writeFileSync(path.join(packageDirectory, 'README.md'), '# fixture\n');
  fs.writeFileSync(path.join(packageDirectory, 'LICENSE'), 'MIT\n');
  git(root, ['init']);
  git(root, ['config', 'user.email', 'test@example.invalid']);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'initial']);
  return root;
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function runNode(root: string, script: string): void {
  const result = spawnSync(process.execPath, [path.join(root, 'packages/ozon-master/scripts', script)], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`Command failed: ${result.stderr || result.stdout}`);
}
