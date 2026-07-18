#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const MIN_NODE_MAJOR = 20;
const PACKAGE_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE = JSON.parse(fs.readFileSync(path.join(PACKAGE_DIRECTORY, 'release-manifest.json'), 'utf8'));

const [command = 'help', ...rawArgs] = process.argv.slice(2);
const options = parseOptions(rawArgs);

try {
  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
  } else if (command === 'init') {
    init(options);
  } else if (command === 'doctor') {
    doctor(resolveDirectory(options.dir));
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  console.error(`\nozon-master: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

function parseOptions(args) {
  const result = { agent: 'all', dir: undefined, skipBrowser: false, skipMcp: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--agent') result.agent = requireValue(args, ++index, '--agent');
    else if (arg === '--dir') result.dir = requireValue(args, ++index, '--dir');
    else if (arg === '--skip-browser') result.skipBrowser = true;
    else if (arg === '--skip-mcp') result.skipMcp = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!['codex', 'claude', 'hermes', 'all', 'none'].includes(result.agent)) {
    throw new Error('--agent must be codex, claude, hermes, all, or none.');
  }
  return result;
}

function requireValue(args, index, name) {
  const value = args[index];
  if (!value || value.startsWith('--')) throw new Error(`${name} needs a value.`);
  return value;
}

function init(options) {
  assertNode();
  assertCommand('git', 'Install Git, then rerun this command.');
  ensurePnpm();
  assertPinnedReleaseManifest();
  const directory = resolveDirectory(options.dir);

  if (fs.existsSync(directory)) {
    assertProjectDirectory(directory);
    verifyPinnedRepository(directory);
    console.log(`Using verified pinned repository: ${directory}`);
  } else {
    installPinnedRepository(directory);
  }

  run('pnpm', ['install', '--frozen-lockfile'], directory);
  run('git', ['submodule', 'update', '--init', '--recursive'], directory);

  if (!options.skipBrowser) ensureBrowser(directory);
  if (!options.skipMcp) ensureMcp(directory);
  installAgentPointers(directory, options.agent);
  doctor(directory);
  console.log('\nInstalled. Ask your Agent to read this file before working:');
  console.log(path.join(directory, 'SKILL.md'));
  console.log('Store API keys and 1688 login are configured locally after installation; they were not copied by ozon-master.');
}

function ensurePnpm() {
  if (commandExists('pnpm')) return;
  if (!commandExists('corepack')) {
    throw new Error('pnpm is required. Install pnpm or enable Corepack, then rerun this command.');
  }
  run('corepack', ['enable']);
  if (!commandExists('pnpm')) throw new Error('Corepack did not expose pnpm. Install pnpm and rerun this command.');
}

function installPinnedRepository(directory) {
  console.log(`Installing Auto Ozon Skill ${RELEASE.git_ref} (${RELEASE.commit.slice(0, 12)}) into: ${directory}`);
  fs.mkdirSync(directory, { recursive: true });
  run('git', ['init'], directory);
  run('git', ['remote', 'add', 'origin', RELEASE.repository_url], directory);
  run('git', ['fetch', '--depth', '1', 'origin', RELEASE.git_ref], directory);
  run('git', ['checkout', '--detach', 'FETCH_HEAD'], directory);
  verifyPinnedRepository(directory);
  run('git', ['submodule', 'update', '--init', '--recursive'], directory);
}

function assertPinnedReleaseManifest() {
  if (!RELEASE.commit || !RELEASE.tree || !RELEASE.tree_sha256 || RELEASE.git_ref === 'unreleased'
    || !/^[a-f0-9]{40}$/i.test(RELEASE.commit) || !/^[a-f0-9]{40}$/i.test(RELEASE.tree)
    || !/^[a-f0-9]{64}$/i.test(RELEASE.tree_sha256)) {
    throw new Error('This ozon-master package was not built from a pinned release. Install an official published version.');
  }
}

function verifyPinnedRepository(directory) {
  const commit = gitOutput(['rev-parse', 'HEAD'], directory);
  const tree = gitOutput(['rev-parse', 'HEAD^{tree}'], directory);
  const treeSha256 = gitArchiveSha256(directory);
  if (commit !== RELEASE.commit || tree !== RELEASE.tree || treeSha256 !== RELEASE.tree_sha256) {
    throw new Error('Pinned repository verification failed; the checkout was not trusted.');
  }
  if (gitOutput(['status', '--porcelain', '--untracked-files=no'], directory)) {
    throw new Error('Pinned repository has tracked local modifications; use a clean target directory.');
  }
}

function doctor(directory) {
  assertNode();
  console.log(`\nAuto Ozon environment check: ${directory}`);
  report('repository', fs.existsSync(path.join(directory, 'package.json')));
  report('git', commandExists('git'));
  report('pnpm', commandExists('pnpm'));
  report('Chrome or Chromium', findBrowser() !== undefined);
  report('Playwright Chromium cache', playwrightChromiumInstalled());
  report('Ozon MCP submodule', fs.existsSync(path.join(directory, 'vendor', 'ozon-mcp', 'pyproject.toml')));
  report('uv (required for Ozon MCP)', commandExists('uv'));
  report('Codex Skill pointer', fs.existsSync(path.join(codexSkillDirectory(), 'SKILL.md')));
  report('Claude Skill pointer', fs.existsSync(path.join(claudeSkillDirectory(), 'SKILL.md')));
  report('Hermes Skill pointer', fs.existsSync(path.join(hermesSkillDirectory(), 'SKILL.md')));
}

function report(name, ok) {
  console.log(`${ok ? 'OK  ' : 'MISS'} ${name}`);
}

function ensureBrowser(directory) {
  if (findBrowser()) {
    console.log('A local Chrome/Chromium installation was found.');
    return;
  }
  console.log('Chrome was not found. Downloading Playwright Chromium...');
  run('pnpm', ['exec', 'playwright', 'install', 'chromium'], directory);
}

function ensureMcp(directory) {
  if (!commandExists('uv')) {
    console.warn('\nOzon MCP was not initialized because uv is missing. Install uv from https://docs.astral.sh/uv/getting-started/installation/ and run:');
    console.warn(`  cd ${path.join(directory, 'vendor', 'ozon-mcp')}`);
    console.warn('  uv sync');
    return;
  }
  run('uv', ['sync'], path.join(directory, 'vendor', 'ozon-mcp'));
}

function installAgentPointers(directory, agent) {
  if (agent === 'none') return;
  if (agent === 'codex' || agent === 'all') writePointer(codexSkillDirectory(), directory, 'Codex');
  if (agent === 'claude' || agent === 'all') writePointer(claudeSkillDirectory(), directory, 'Claude Code');
  if (agent === 'hermes' || agent === 'all') writePointer(hermesSkillDirectory(), directory, 'Hermes');
}

function writePointer(skillDirectory, repositoryDirectory, agentName) {
  fs.mkdirSync(skillDirectory, { recursive: true });
  const skillPath = path.join(skillDirectory, 'SKILL.md');
  const escapedPath = repositoryDirectory.replaceAll('\\', '\\\\');
  const content = `---\nname: ozon-master\ndescription: Use the local Auto Ozon Skill repository to collect 1688 products, prepare Ozon listings, configure stores, or inspect Ozon MCP workflows.\n---\n\n# Auto Ozon Skill pointer\n\nThis ${agentName} installation points to a local repository. Before taking any action, read its total router:\n\n\\\`${escapedPath}\\\\SKILL.md\\\`\n\nThen follow the repository's AGENTS.md and the specialized Skill files it routes to. Never copy or disclose secrets from its .env or local configuration files.\n`;
  fs.writeFileSync(skillPath, content, 'utf8');
  console.log(`Installed ${agentName} Skill pointer: ${skillPath}`);
}

function codexSkillDirectory() {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'skills', 'ozon-master');
}

function claudeSkillDirectory() {
  return path.join(os.homedir(), '.claude', 'skills', 'ozon-master');
}

function hermesSkillDirectory() {
  return path.join(os.homedir(), '.hermes', 'skills', 'ozon-master');
}

function resolveDirectory(value) {
  return path.resolve(value || path.join(process.cwd(), 'auto-ozon-skill'));
}

function assertProjectDirectory(directory) {
  if (!fs.existsSync(path.join(directory, 'package.json')) || !fs.existsSync(path.join(directory, 'SKILL.md'))) {
    throw new Error(`Target exists but is not an Auto Ozon Skill repository: ${directory}`);
  }
}

function assertNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isInteger(major) || major < MIN_NODE_MAJOR) {
    throw new Error(`Node.js ${MIN_NODE_MAJOR}+ is required. Current: ${process.version}`);
  }
}

function assertCommand(command, hint) {
  if (!commandExists(command)) throw new Error(`${command} is required. ${hint}`);
}

function commandExists(command) {
  const locator = process.platform === 'win32' ? 'where' : 'which';
  return spawnSync(locator, [command], { stdio: 'ignore' }).status === 0;
}

function run(command, args, cwd) {
  const pnpmEntrypoint = command === 'pnpm' ? resolvePnpmEntrypoint() : undefined;
  if (pnpmEntrypoint) {
    const result = spawnSync(process.execPath, [pnpmEntrypoint, ...args], { cwd, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}.`);
    return;
  }
  const executable = resolveExecutable(command);
  const result = spawnSync(executable, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}.`);
}

function gitOutput(args, cwd) {
  const result = spawnSync(resolveExecutable('git'), args, { cwd, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed with exit code ${result.status}.`);
  return String(result.stdout || '').trim();
}

function gitArchiveSha256(cwd) {
  const result = spawnSync(resolveExecutable('git'), ['archive', '--format=tar', 'HEAD'], { cwd, encoding: null, maxBuffer: 512 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) throw new Error('git archive failed while verifying release content.');
  return crypto.createHash('sha256').update(result.stdout).digest('hex');
}

function findBrowser() {
  const candidates = process.platform === 'win32'
    ? [
      path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ]
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate));
}

function playwrightChromiumInstalled() {
  const browserPath = process.env.PLAYWRIGHT_BROWSERS_PATH || (process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || os.homedir(), 'ms-playwright')
    : process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')
      : path.join(os.homedir(), '.cache', 'ms-playwright'));
  if (!fs.existsSync(browserPath)) return false;
  return fs.readdirSync(browserPath, { withFileTypes: true }).some((entry) => {
    if (!entry.isDirectory() || !entry.name.startsWith('chromium-')) return false;
    const root = path.join(browserPath, entry.name);
    const candidates = process.platform === 'win32'
      ? [path.join(root, 'chrome-win', 'chrome.exe'), path.join(root, 'chrome-win64', 'chrome.exe')]
      : process.platform === 'darwin'
        ? [path.join(root, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'), path.join(root, 'chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium')]
        : [path.join(root, 'chrome-linux', 'chrome'), path.join(root, 'chrome-linux64', 'chrome')];
    return candidates.some(fs.existsSync);
  });
}

function printHelp() {
  console.log(`ozon-master — Auto Ozon Skill installer\n\nUsage:\n  pnpm dlx ozon-master init --agent all\n  pnpm dlx ozon-master doctor --dir .\\auto-ozon-skill\n\nOptions:\n  --agent <codex|claude|hermes|all|none>  Install local Agent Skill pointers (default: all)\n  --dir <path>                              Target repository directory\n  --skip-browser                             Do not install Playwright Chromium when Chrome is absent\n  --skip-mcp                                 Do not initialize Ozon MCP\n`);
}

function resolvePnpmEntrypoint() {
  if (process.platform !== 'win32') return undefined;
  const lookup = spawnSync('where.exe', ['pnpm.cmd'], { encoding: 'utf8' });
  const launcher = String(lookup.stdout || '').split(/\r?\n/).find(Boolean);
  if (!launcher) return undefined;
  const corepackEntrypoint = path.join(path.dirname(launcher), 'node_modules', 'corepack', 'dist', 'pnpm.js');
  return fs.existsSync(corepackEntrypoint) ? corepackEntrypoint : undefined;
}

function resolveExecutable(command) {
  if (process.platform !== 'win32') return command;
  const lookup = spawnSync('where.exe', [command], { encoding: 'utf8' });
  const candidates = String(lookup.stdout || '').split(/\r?\n/).filter(Boolean);
  const candidate = candidates.find((entry) => /\.(?:exe|cmd|bat)$/i.test(entry)) ?? candidates[0];
  return candidate || command;
}
