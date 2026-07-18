import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const violations = [];
for (const file of files.filter((name) => /\.(?:ts|mts|cts|mjs)$/u.test(name))) {
  const text = fs.readFileSync(file, 'utf8');
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (/\s+$/u.test(line)) violations.push(`${file}:${index + 1}: trailing whitespace`);
    if (/@ts-(?:nocheck|ignore)\b/u.test(line)) violations.push(`${file}:${index + 1}: forbidden TypeScript suppression`);
  }
}
if (violations.length > 0) {
  process.stderr.write(`${violations.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`static checks passed for ${files.length} tracked files\n`);
