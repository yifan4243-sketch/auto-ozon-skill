import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

export function root(): string {
  return process.env.BB1688_HOME ?? path.join(os.homedir(), '.1688');
}

export function profilesDir(): string {
  return path.join(root(), 'profiles');
}

export function defaultProfileName(profile?: string): string {
  const name = profile?.trim();
  const resolved = name ? name : 'default';
  assertSafeProfileName(resolved);
  return resolved;
}

export function profileRuntimeDir(profile?: string): string {
  const name = defaultProfileName(profile);
  return name === 'default' ? root() : profilePath(name);
}

export function stateFile(profile?: string): string {
  return path.join(profileRuntimeDir(profile), 'state.json');
}

export function lockFile(profile?: string): string {
  return path.join(profileRuntimeDir(profile), '.lock');
}

export function runsDir(): string {
  return path.join(root(), 'runs');
}

export function eventsFile(): string {
  return path.join(root(), 'events.jsonl');
}

export function configFile(): string {
  return path.join(root(), 'config.json');
}

export function loginQrFile(): string {
  return path.join(root(), 'login-qr.png');
}

export function profilePath(name = 'default'): string {
  const base = path.resolve(profilesDir());
  const resolved = path.resolve(base, defaultProfileName(name));
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
    throw new Error(`Profile path escapes the profile root: ${name}`);
  }
  return resolved;
}

export async function ensureRoot(): Promise<void> {
  await fs.mkdir(root(), { recursive: true });
}

export async function ensureProfileRuntimeDir(profile?: string): Promise<void> {
  await fs.mkdir(profileRuntimeDir(profile), { recursive: true });
}

export function assertSafeProfileName(name: string): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(name)) {
    throw new Error(
      `Invalid 1688 profile name: ${name}. Use 1-64 ASCII letters, digits, underscores, or hyphens.`,
    );
  }
}
