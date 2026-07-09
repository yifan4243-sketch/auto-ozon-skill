import fs from 'node:fs/promises';
import lockfile from 'proper-lockfile';
import {
  defaultProfileName,
  ensureProfileRuntimeDir,
  lockFile,
} from './paths.js';
import { CliError } from '../io/errors.js';

export async function acquireLock(profile?: string): Promise<() => Promise<void>> {
  const profileName = defaultProfileName(profile);
  await ensureProfileRuntimeDir(profileName);
  const target = lockFile(profileName);
  await fs.writeFile(target, '', { flag: 'a' });

  const lockOpts = { retries: 0, stale: 5 * 60 * 1000 };

  try {
    return await lockfile.lock(target, lockOpts);
  } catch (error) {
    if ((error as { code?: string }).code !== 'ELOCKED') throw error;

    const semaphore = `${target}.lock`;
    const stale = await isStaleLock(semaphore, lockOpts.stale);
    if (stale) {
      await fs.rm(semaphore, { recursive: true, force: true });
      try {
        return await lockfile.lock(target, lockOpts);
      } catch {
        // Fall through to the structured busy error below.
      }
    }

    throw new CliError(
      5,
      'LOCK_BUSY',
      `Another 1688 inline command is running for profile "${profileName}". Close it and retry.`,
    );
  }
}

async function isStaleLock(lockDir: string, staleMs: number): Promise<boolean> {
  try {
    const stat = await fs.stat(lockDir);
    return Date.now() - stat.mtimeMs > staleMs;
  } catch {
    return false;
  }
}
