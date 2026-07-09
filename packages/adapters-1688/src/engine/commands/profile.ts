import fs from 'node:fs/promises';
import path from 'node:path';
import { emit } from '../io/output.js';
import { CliError } from '../io/errors.js';
import { defaultProfileName, lockFile, profilePath, profilesDir } from '../session/paths.js';
import { readState } from '../session/state.js';
import { readRecentEventSummaries } from '../session/events.js';

export interface ProfileSummary {
  name: string;
  path: string;
  exists: boolean;
  locked: boolean;
  loggedIn: boolean;
  recentRequestId: string | null;
  recentStatus: string | null;
  recentErrorCode: string | null;
}

export async function list(): Promise<void> {
  const profiles = await collectProfiles();
  emit({
    human: () => {
      if (profiles.length === 0) {
        process.stdout.write('No profiles found.\n');
        return;
      }
      for (const profile of profiles) {
        const lock = profile.locked ? 'locked' : 'free';
        const recent = profile.recentRequestId ? ` last=${profile.recentRequestId}` : '';
        process.stdout.write(`${profile.name} ${lock}${recent}\n`);
      }
    },
    data: { profiles },
  });
}

export async function status(name = 'default'): Promise<void> {
  const profileName = defaultProfileName(name);
  const profiles = await collectProfiles();
  const summary = profiles.find((p) => p.name === profileName) ?? (await summarizeProfile(profileName));
  if (!summary.exists && profileName !== 'default') {
    throw new CliError(2, 'NOT_FOUND', `Profile not found: ${profileName}`);
  }
  const state = await readState(profileName).catch(() => null);
  emit({
    human: () => {
      process.stdout.write(`profile: ${summary.name}\n`);
      process.stdout.write(`path: ${summary.path}\n`);
      process.stdout.write(`exists: ${summary.exists}\n`);
      process.stdout.write(`locked: ${summary.locked}\n`);
      if (state?.memberId) process.stdout.write(`memberId: ${state.memberId}\n`);
      if (summary.recentRequestId) process.stdout.write(`recent: ${summary.recentRequestId}\n`);
    },
    data: { profile: summary, state },
  });
}

async function collectProfiles(): Promise<ProfileSummary[]> {
  const names = new Set<string>(['default']);
  try {
    for (const entry of await fs.readdir(profilesDir(), { withFileTypes: true })) {
      if (entry.isDirectory()) names.add(entry.name);
    }
  } catch {
    // No profiles directory yet.
  }
  const summaries = await Promise.all([...names].sort().map(summarizeProfile));
  return summaries.filter((p) => p.exists || p.name === 'default');
}

async function summarizeProfile(name: string): Promise<ProfileSummary> {
  const profileName = defaultProfileName(name);
  const dir = profilePath(profileName);
  const exists = await pathExists(dir);
  const locked = await pathExists(lockFile(profileName) + '.lock');
  const recent = (await readRecentEventSummaries(50))
    .reverse()
    .find((s) => s.profile === profileName || (!s.profile && profileName === 'default'));
  const state = await readState(profileName).catch(() => null);
  return {
    name: profileName,
    path: dir,
    exists,
    locked,
    loggedIn: !!state?.memberId,
    recentRequestId: recent?.requestId ?? null,
    recentStatus: recent?.status ?? null,
    recentErrorCode: recent?.errorCode ?? null,
  };
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(path.resolve(target));
    return true;
  } catch {
    return false;
  }
}
