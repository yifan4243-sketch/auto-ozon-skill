import os from 'node:os';
import path from 'node:path';

export function debugTmpPath(filename: string): string {
  return path.join(os.tmpdir(), filename);
}
