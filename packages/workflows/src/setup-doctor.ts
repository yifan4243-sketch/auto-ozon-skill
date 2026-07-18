import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type {
  CommandResult,
  SetupCheckV1,
  SetupReportV1,
  SetupStoreStatusV1,
} from '@auto-ozon/contracts';
import { resolveRepoRoot } from '@auto-ozon/artifact-store';
import { EnvSecretProvider, FileStoreRegistry, resolveStoreCredentials } from '@auto-ozon/config';
import { loadOzonEnvironment } from '@auto-ozon/adapters-ozon';
import { loadOzonCategoryTree } from '@auto-ozon/step-category-decision';
import { validateImageGenerationConfig } from './image-generation-config.js';

export interface SetupDoctorOptionsV1 {
  repo_root?: string;
  environment?: Readonly<Record<string, string | undefined>>;
}

export async function runSetupDoctor(
  options: SetupDoctorOptionsV1 = {},
): Promise<CommandResult<SetupReportV1>> {
  const root = path.resolve(options.repo_root ?? resolveRepoRoot());
  const checks: SetupCheckV1[] = [];
  const stores: SetupStoreStatusV1[] = [];
  const environmentInput: NodeJS.ProcessEnv = options.environment
    ? { ...options.environment }
    : process.env;
  const environment = { ...loadOzonEnvironment(environmentInput, root) };

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push(check(
    'NODE_20',
    Number.isInteger(nodeMajor) && nodeMajor >= 20,
    `Node.js ${process.version}`,
    'Install Node.js 20 or newer.',
  ));
  checks.push(check(
    'PNPM_AVAILABLE',
    commandExists('pnpm'),
    'pnpm command is available.',
    'Enable Corepack or install pnpm.',
  ));
  checks.push(check(
    'BROWSER_AVAILABLE',
    Boolean(findChrome() || findPlaywrightChromium()),
    'Chrome or Playwright Chromium is available.',
    'Install Google Chrome or run: pnpm exec playwright install chromium',
  ));

  const profiles = listLoggedIn1688Profiles(environment.BB1688_HOME);
  checks.push(check(
    'TWO_1688_ACCOUNTS',
    profiles.length >= 2,
    `${profiles.length} locally authenticated 1688 profile(s) found.`,
    'Log in to at least two 1688 profiles before running a batch.',
    { profile_count: profiles.length },
  ));

  try {
    const registry = new FileStoreRegistry(path.join(root, 'data', 'config', 'ozon-stores.local.json'));
    const secretProvider = new EnvSecretProvider(environment);
    for (const profile of registry.list()) {
      let credentialsConfigured = false;
      try {
        resolveStoreCredentials(profile, secretProvider);
        credentialsConfigured = true;
      } catch {
        credentialsConfigured = false;
      }
      stores.push({
        store_id: profile.store_id,
        store_name: profile.store_name,
        publishing_enabled: profile.publishing.enabled,
        currency_code: profile.currency_code,
        credentials_configured: credentialsConfigured,
      });
    }
    checks.push(check(
      'STORE_REGISTRY',
      stores.length > 0,
      `${stores.length} local Ozon store profile(s) found.`,
      'Create data/config/ozon-stores.local.json with at least one StoreProfileV2.',
      { store_count: stores.length },
    ));
    checks.push(check(
      'STORE_CREDENTIALS',
      stores.length > 0 && stores.every((store) => store.credentials_configured),
      `${stores.filter((store) => store.credentials_configured).length}/${stores.length} store credential pair(s) resolve locally.`,
      'Set each store profile client-id and API-key SecretRef in the local environment.',
    ));
  } catch (error) {
    checks.push({
      code: 'STORE_REGISTRY',
      status: 'failed',
      message: safeError(error),
      fix: 'Create a valid ignored data/config/ozon-stores.local.json file.',
    });
  }

  const marketSnapshot = path.join(root, 'data', 'ozon', 'category-analytics', 'raw', 'ozon-category-year-2026-06-17.json');
  try {
    const bytes = fs.readFileSync(marketSnapshot);
    const snapshot = JSON.parse(bytes.toString('utf8')) as { captured_at?: unknown; finished?: unknown; stopped?: unknown; level3?: unknown };
    const level3Count = Array.isArray(snapshot.level3) ? snapshot.level3.length : 0;
    const ready = snapshot.finished === true && snapshot.stopped === false && level3Count > 0
      && typeof snapshot.captured_at === 'string' && Number.isFinite(Date.parse(snapshot.captured_at));
    checks.push(check(
      'MARKET_SNAPSHOT',
      ready,
      ready ? `Annual Ozon market snapshot contains ${level3Count} level-3 categories.` : 'Annual Ozon market snapshot is incomplete.',
      'Restore a completed annual category analytics snapshot before creating market-selection batches.',
      ready ? { captured_at: snapshot.captured_at as string, sha256: createHash('sha256').update(bytes).digest('hex') } : undefined,
    ));
  } catch (error) {
    checks.push({ code: 'MARKET_SNAPSHOT', status: 'failed', message: safeError(error), fix: 'Restore the annual Ozon category analytics snapshot.' });
  }

  const commissionSnapshot = path.join(root, 'packages', 'steps', 'cost-pricing', 'references', 'ozon-commission-snapshot.json');
  checks.push(check(
    'COMMISSION_SNAPSHOT',
    fs.existsSync(commissionSnapshot) && fs.statSync(commissionSnapshot).size > 0,
    'Bundled Ozon commission snapshot is present.',
    'Restore packages/steps/cost-pricing/references/ozon-commission-snapshot.json.',
  ));

  const imageConfigPath = path.join(root, 'data', 'config', 'image-generation.local.json');
  if (!fs.existsSync(imageConfigPath)) {
    checks.push(check('IMAGE_GENERATION_OPTIONAL', true, 'Image generation is not configured; validated 1688 originals will be used.', ''));
  } else {
    try {
      const imageConfig = validateImageGenerationConfig(JSON.parse(fs.readFileSync(imageConfigPath, 'utf8')) as unknown);
      checks.push(check('IMAGE_GENERATION_CONFIG', true, `Optional image provider ${imageConfig.provider_id} is configured.`, ''));
      checks.push(check(
        'IMAGE_GENERATION_SECRET',
        Boolean(environment[imageConfig.api_key_env]?.trim()),
        'Optional image-provider secret reference resolves locally.',
        `Set ${imageConfig.api_key_env} in the local environment or .env file.`,
      ));
    } catch (error) {
      checks.push({ code: 'IMAGE_GENERATION_CONFIG', status: 'failed', message: safeError(error), fix: 'Fix or remove data/config/image-generation.local.json.' });
    }
  }

  try {
    const tree = await loadOzonCategoryTree();
    checks.push({
      code: 'CATEGORY_SNAPSHOT',
      status: 'passed',
      message: `Ozon category snapshot is valid until ${tree.snapshot.valid_to}.`,
      fix: null,
      detail: { captured_at: tree.snapshot.captured_at, valid_to: tree.snapshot.valid_to, sha256: tree.snapshot.sha256 },
    });
  } catch (error) {
    checks.push({
      code: 'CATEGORY_SNAPSHOT',
      status: 'failed',
      message: safeError(error),
      fix: 'Refresh the Ozon category tree and its signed metadata before preparing listings.',
    });
  }

  const mcpProject = path.join(root, 'vendor', 'ozon-mcp', 'pyproject.toml');
  checks.push(check(
    'OZON_MCP',
    fs.existsSync(mcpProject) && commandExists('uv'),
    'Ozon MCP source and uv runtime are available.',
    'Initialize the Ozon MCP submodule and install uv, then run uv sync.',
  ));
  checks.push(check(
    'STATE_DIRECTORIES',
    directoryWritable(path.join(root, 'data')),
    'The local data directory is writable.',
    'Grant the current user write access to the repository data directory.',
  ));

  const failed = checks.filter((entry) => entry.status === 'failed').length;
  const warnings = checks.filter((entry) => entry.status === 'warning').length;
  const report: SetupReportV1 = {
    schema_version: 1,
    checked_at: new Date().toISOString(),
    status: failed > 0 ? 'blocked' : warnings > 0 ? 'needs_attention' : 'ready',
    checks,
    stores,
    profiles_1688: profiles,
  };
  return {
    ok: report.status !== 'blocked',
    command: 'setup.doctor',
    data: report,
    warnings: checks.filter((entry) => entry.status === 'warning').map((entry) => ({ code: entry.code, message: entry.message })),
    errors: checks.filter((entry) => entry.status === 'failed').map((entry) => ({ code: entry.code, message: entry.message, recoverable: true })),
    nextActions: checks.flatMap((entry) => entry.status === 'passed' || !entry.fix ? [] : [entry.fix]),
  };
}

function check(
  code: string,
  passed: boolean,
  message: string,
  fix: string,
  detail?: Record<string, string | number | boolean | null>,
): SetupCheckV1 {
  return { code, status: passed ? 'passed' : 'failed', message, fix: passed ? null : fix, ...(detail ? { detail } : {}) };
}

function listLoggedIn1688Profiles(configuredHome?: string): string[] {
  const home = path.resolve(configuredHome ?? path.join(os.homedir(), '.1688'));
  const profilesRoot = path.join(home, 'profiles');
  const authenticated = new Set<string>();
  if (hasAuthenticatedState(path.join(home, 'state.json'))) authenticated.add('default');
  try {
    for (const entry of fs.readdirSync(profilesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[A-Za-z0-9_-]{1,64}$/u.test(entry.name)) continue;
      const profileRoot = path.resolve(profilesRoot, entry.name);
      if (!profileRoot.startsWith(`${path.resolve(profilesRoot)}${path.sep}`)) continue;
      if (hasAuthenticatedState(path.join(profileRoot, 'state.json'))) authenticated.add(entry.name);
    }
  } catch {
    // Profiles are optional until the customer completes first-use setup.
  }
  return [...authenticated].sort();
}

function hasAuthenticatedState(file: string): boolean {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: unknown; memberId?: unknown };
    return state.version === 1 && typeof state.memberId === 'string' && state.memberId.trim().length > 0;
  } catch {
    return false;
  }
}

function commandExists(command: string): boolean {
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  return spawnSync(locator, [command], { stdio: 'ignore', windowsHide: true, env: safeProcessEnvironment() }).status === 0;
}

function safeProcessEnvironment(): NodeJS.ProcessEnv {
  const allowed = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA'];
  return Object.fromEntries(allowed.flatMap((key) => process.env[key] ? [[key, process.env[key]]] : []));
}

function findChrome(): string | null {
  const candidates = process.platform === 'win32'
    ? [
        path.join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ]
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'];
  return candidates.find((candidate) => Boolean(candidate) && fs.existsSync(candidate)) ?? null;
}

function findPlaywrightChromium(): string | null {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH
    ?? (process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'ms-playwright')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')
        : path.join(os.homedir(), '.cache', 'ms-playwright'));
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('chromium-')) continue;
      const versionRoot = path.join(root, entry.name);
      const candidates = process.platform === 'win32'
        ? [path.join(versionRoot, 'chrome-win', 'chrome.exe'), path.join(versionRoot, 'chrome-win64', 'chrome.exe')]
        : process.platform === 'darwin'
          ? [path.join(versionRoot, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'), path.join(versionRoot, 'chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium')]
          : [path.join(versionRoot, 'chrome-linux', 'chrome'), path.join(versionRoot, 'chrome-linux64', 'chrome')];
      const executable = candidates.find(fs.existsSync);
      if (executable) return executable;
    }
    return null;
  } catch {
    return null;
  }
}

function directoryWritable(directory: string): boolean {
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/npm_[A-Za-z0-9_-]+/gu, '[REDACTED]').replace(/[A-Fa-f0-9]{32,}/gu, '[REDACTED]');
}
