import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, '../bin/ozon-master.mjs');

test('help describes the init command', () => {
  const result = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /pnpm dlx ozon-master init --agent all/);
  assert.match(result.stdout, /codex\|claude\|hermes\|all\|none/);
});

test('unknown command fails without running an installer', () => {
  const result = spawnSync(process.execPath, [cli, 'unknown'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown command/);
});
