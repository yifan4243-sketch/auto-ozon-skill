import fs from 'node:fs/promises';
import path from 'node:path';
import { stateFile, ensureRoot } from './paths.js';

export interface State {
  version: 1;
  memberId?: string;
  nick?: string;
  loggedInAt?: string;
  lastVerifiedAt?: string;
}

const EMPTY: State = { version: 1 };

export async function readState(profile?: string): Promise<State> {
  try {
    const buf = await fs.readFile(stateFile(profile), 'utf8');
    const parsed = JSON.parse(buf) as Partial<State>;
    if (parsed?.version !== 1) return { ...EMPTY };
    return { ...EMPTY, ...parsed };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY };
    throw e;
  }
}

export async function writeState(s: State, profile?: string): Promise<void> {
  await ensureRoot();
  await fs.mkdir(path.dirname(stateFile(profile)), { recursive: true });
  await fs.writeFile(stateFile(profile), JSON.stringify(s, null, 2));
}

export async function clearState(profile?: string): Promise<void> {
  await writeState({ ...EMPTY }, profile);
}
