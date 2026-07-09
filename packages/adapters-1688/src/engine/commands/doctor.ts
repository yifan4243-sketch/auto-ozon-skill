import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import {
  defaultProfileName,
  root,
  stateFile,
  lockFile,
  profilePath,
  runsDir,
} from '../session/paths.js';
import { readState } from '../session/state.js';
import { emit } from '../io/output.js';
import { CliError } from '../io/errors.js';
import { appendEvent, readRecentEvents } from '../session/events.js';

export interface VersionInfo {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  updateCommand: string | null;
  error: string | null;
}

export interface DoctorOpts {
  launch?: boolean;
  live?: boolean;
  profile?: string;
}

type Status = 'ok' | 'warn' | 'fail';

interface Check {
  name: string;
  status: Status;
  message: string;
  fix?: string;
}

const VERSION: VersionInfo = {
  current: '0.0.0',
  latest: null,
  updateAvailable: false,
  updateCommand: null,
  error: null,
};

export async function run(opts: DoctorOpts): Promise<void> {
  const profile = defaultProfileName(opts.profile);
  const checks: Check[] = [];
  checks.push(checkNode());
  checks.push(await checkYibabaRoot());
  checks.push(await checkProfile(profile));
  checks.push(await checkChromiumCache());
  checks.push(await checkLock(profile));
  checks.push(await checkStateFile(profile));
  if (opts.launch !== false) checks.push(await checkChromiumLaunch());
  checks.push(await checkSession(profile));
  if (opts.live) {
    checks.push(await checkEventLogWrite(profile));
    checks.push(await checkArtifactWrite());
    checks.push(await checkRecentRiskEvent(profile));
  }
  checks.push({ name: 'Version', status: 'ok', message: VERSION.current });

  const failed = checks.some((c) => c.status === 'fail');
  emit({
    human: () => printHuman(checks),
    data: { ok: !failed, profile, checks, version: VERSION },
  });

  if (failed) throw new CliError(6, 'DOCTOR_FAILED', '');
}

function checkNode(): Check {
  const v = process.versions.node;
  const major = parseInt(v.split('.')[0] ?? '0', 10);
  if (major >= 20) return { name: 'Node version', status: 'ok', message: `v${v}` };
  return {
    name: 'Node version',
    status: 'fail',
    message: `v${v} (need >= 20)`,
    fix: 'Upgrade Node to 20 or newer.',
  };
}

export function writePermissionFix(dir: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return `Grant write permission to "${dir}" or set BB1688_HOME to a writable directory.`;
  }
  return `chmod u+w "${dir}"`;
}

export function removePathFix(
  target: string,
  platform: NodeJS.Platform = process.platform,
  opts: { recursive?: boolean } = {},
): string {
  if (platform === 'win32') {
    return opts.recursive
      ? `PowerShell: Remove-Item -Recurse -Force "${target}"`
      : `PowerShell: Remove-Item -Force "${target}"`;
  }
  return opts.recursive ? `rm -rf "${target}"` : `rm "${target}"`;
}

async function checkYibabaRoot(): Promise<Check> {
  const dir = root();
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.access(dir, fs.constants.W_OK);
    return { name: '1688 home', status: 'ok', message: dir };
  } catch (error) {
    return {
      name: '1688 home',
      status: 'fail',
      message: `${dir}: ${(error as Error).message}`,
      fix: writePermissionFix(dir),
    };
  }
}

async function checkProfile(name?: string): Promise<Check> {
  const dir = profilePath(name);
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.access(dir, fs.constants.W_OK);
    return { name: 'profile dir', status: 'ok', message: dir };
  } catch (error) {
    return {
      name: 'profile dir',
      status: 'fail',
      message: `${dir}: ${(error as Error).message}`,
    };
  }
}

function chromiumCacheDir(): string {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library/Caches/ms-playwright');
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'ms-playwright');
  }
  return path.join(os.homedir(), '.cache/ms-playwright');
}

async function checkChromiumCache(): Promise<Check> {
  const cache = chromiumCacheDir();
  try {
    const entries = await fs.readdir(cache);
    const hit = entries.find((n) => n.startsWith('chromium'));
    if (hit) return { name: 'Chromium cache', status: 'ok', message: `${hit} @ ${cache}` };
    return {
      name: 'Chromium cache',
      status: 'fail',
      message: `no chromium-* dir in ${cache}`,
      fix: 'npx playwright install chromium',
    };
  } catch {
    return {
      name: 'Chromium cache',
      status: 'fail',
      message: `cache dir missing (${cache})`,
      fix: 'npx playwright install chromium',
    };
  }
}

async function checkLock(profile: string): Promise<Check> {
  const semaphore = lockFile(profile) + '.lock';
  try {
    const stat = await fs.stat(semaphore);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > 5 * 60 * 1000) {
      return {
        name: 'lock',
        status: 'warn',
        message: `stale lock (${Math.round(ageMs / 1000)}s old)`,
        fix: removePathFix(semaphore, process.platform, { recursive: true }),
      };
    }
    return {
      name: 'lock',
      status: 'warn',
      message: `another inline command appears to be running for profile "${profile}"`,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { name: 'lock', status: 'ok', message: 'free' };
    }
    return { name: 'lock', status: 'warn', message: `unknown: ${(error as Error).message}` };
  }
}

async function checkStateFile(profile: string): Promise<Check> {
  try {
    const state = await readState(profile);
    if (state.version !== 1) {
      return { name: 'state.json', status: 'warn', message: `unexpected version ${state.version}` };
    }
    return { name: 'state.json', status: 'ok', message: stateFile(profile) };
  } catch (error) {
    return {
      name: 'state.json',
      status: 'warn',
      message: `unreadable: ${(error as Error).message}`,
      fix: removePathFix(stateFile(profile)),
    };
  }
}

async function checkChromiumLaunch(): Promise<Check> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bb1688-doctor-'));
  const preferChrome = process.env.BB1688_FORCE_CHROMIUM !== '1';

  async function tryLaunch(opts: { channel?: 'chrome' }): Promise<string> {
    const ctx = await chromium.launchPersistentContext(tmp, {
      headless: true,
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      ...opts,
    });
    await ctx.close();
    return opts.channel === 'chrome' ? 'Chrome' : 'bundled Chromium';
  }

  try {
    if (preferChrome) {
      try {
        return {
          name: 'browser launch',
          status: 'ok',
          message: `headless launch OK (${await tryLaunch({ channel: 'chrome' })})`,
        };
      } catch {
        // Fall through to bundled Chromium.
      }
    }
    return {
      name: 'browser launch',
      status: 'ok',
      message: `headless launch OK (${await tryLaunch({})})`,
    };
  } catch (error) {
    const first = (error as Error).message.split('\n')[0] ?? 'launch failed';
    return {
      name: 'browser launch',
      status: 'fail',
      message: first,
      fix: 'Install Chrome or run: npx playwright install chromium',
    };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

async function checkEventLogWrite(profile: string): Promise<Check> {
  try {
    await appendEvent({
      ts: new Date().toISOString(),
      requestId: `doctor-live-${Date.now().toString(36)}`,
      cmd: 'doctor',
      phase: 'end',
      status: 'ok',
      profile,
    });
    return { name: 'live event log', status: 'ok', message: 'writable' };
  } catch (error) {
    return {
      name: 'live event log',
      status: 'fail',
      message: `unwritable: ${(error as Error).message}`,
      fix: writePermissionFix(root()),
    };
  }
}

async function checkArtifactWrite(): Promise<Check> {
  const dir = path.join(runsDir(), `.doctor-live-${Date.now().toString(36)}`);
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'probe.json'), JSON.stringify({ ok: true }));
    return { name: 'live artifact write', status: 'ok', message: 'writable' };
  } catch (error) {
    return {
      name: 'live artifact write',
      status: 'fail',
      message: `unwritable: ${(error as Error).message}`,
      fix: writePermissionFix(runsDir()),
    };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function checkRecentRiskEvent(profile: string): Promise<Check> {
  const recent = await readRecentEvents(50);
  const risk = [...recent]
    .reverse()
    .find(
      (event) =>
        (event.profile === profile || (!event.profile && profile === 'default')) &&
        (event.verification?.state === 'risk_control' || event.errorCode === 'RISK_CONTROL'),
    );
  if (!risk) {
    return { name: 'live recent risk', status: 'ok', message: 'no recent risk-control event' };
  }
  return {
    name: 'live recent risk',
    status: 'warn',
    message: `recent risk event in ${risk.cmd} (${risk.requestId})`,
    fix: 'Run the affected command with --headed if verification is still active.',
  };
}

async function checkSession(profile: string): Promise<Check> {
  try {
    const state = await readState(profile);
    if (state.memberId) {
      const name = state.nick ?? state.memberId;
      return {
        name: 'session',
        status: 'ok',
        message: `${name} (memberId: ${state.memberId}, profile "${profile}", cached)`,
      };
    }
    return {
      name: 'session',
      status: 'warn',
      message: `not logged in for profile "${profile}"`,
      fix: `auto-ozon 1688 login --profile ${profile}`,
    };
  } catch {
    return { name: 'session', status: 'warn', message: 'unknown' };
  }
}

function printHuman(checks: Check[]): void {
  const pad = Math.max(...checks.map((c) => c.name.length));
  for (const check of checks) {
    const label = check.status.toUpperCase().padEnd(4);
    process.stdout.write(`${label} ${check.name.padEnd(pad)}  ${check.message}\n`);
    if (check.fix && check.status !== 'ok') {
      process.stdout.write(`     ${' '.repeat(pad)}  fix: ${check.fix}\n`);
    }
  }
  const failed = checks.filter((c) => c.status === 'fail').length;
  const warned = checks.filter((c) => c.status === 'warn').length;
  process.stdout.write('\n');
  if (failed) process.stdout.write(`${failed} failed, ${warned} warning(s).\n`);
  else if (warned) process.stdout.write(`All critical checks passed (${warned} warning(s)).\n`);
  else process.stdout.write('All checks passed.\n');
}
