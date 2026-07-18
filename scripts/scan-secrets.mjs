import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const findings = [];
const forbiddenFiles = [/(?:^|\/)\.env(?:$|\.(?:local|production|development))$/u, /(?:^|\/)(?:cookies?|storage-state)\.json$/iu, /\.(?:sqlite|sqlite3|db)$/iu];
const tokenPatterns = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu],
  ['npm token', /\bnpm_[A-Za-z0-9_-]{24,}\b/gu],
  ['GitHub token', /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/gu],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/gu],
];
const dotenvSecret = /^[ \t]*(?:OZON_API_KEY|OZON_PERFORMANCE_CLIENT_SECRET|IMAGE_GENERATION_API_KEY|API_KEY|CLIENT_SECRET|PASSWORD|TOKEN)(?:_[A-Za-z0-9]+)?[ \t]*=[ \t]*([^ \t\r\n#]*)[ \t]*$/gimu;

for (const file of files) {
  if (forbiddenFiles.some((pattern) => pattern.test(file))) findings.push(`${file}: forbidden secret/state file is tracked`);
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 2_000_000) continue;
  const bytes = fs.readFileSync(file);
  if (bytes.includes(0)) continue;
  const text = bytes.toString('utf8');
  for (const [label, pattern] of tokenPatterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) findings.push(`${file}:${lineNumber(text, match.index ?? 0)}: possible ${label}`);
  }
  dotenvSecret.lastIndex = 0;
  for (const match of text.matchAll(dotenvSecret)) {
    const value = match[1] ?? '';
    if (value && !isPlaceholder(value)) findings.push(`${file}:${lineNumber(text, match.index ?? 0)}: possible dotenv secret`);
  }
}

if (findings.length > 0) {
  process.stderr.write(`${findings.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`secret scan passed for ${files.length} tracked files\n`);

function isPlaceholder(value) {
  return /^(?:\[?REDACTED\]?|<[^>]+>|\$\{[^}]+\}|(?:your|replace|example|dummy|fake|fixture|test)[-_A-Za-z0-9.]*)$/iu.test(value);
}
function lineNumber(text, offset) { return text.slice(0, offset).split('\n').length; }
