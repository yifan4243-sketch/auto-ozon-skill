import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  defaultProfileName,
  profilePath,
  profilesDir,
} from '../../../packages/adapters-1688/src/engine/session/paths.js';

describe('1688 profile path safety', () => {
  it('accepts only stable safe profile names', () => {
    expect(defaultProfileName()).toBe('default');
    expect(defaultProfileName('account-2')).toBe('account-2');
    expect(path.dirname(profilePath('account_2'))).toBe(path.resolve(profilesDir()));
  });

  it.each([
    '../escape', '../../escape', 'a/b', 'a\\b', '.', '..', 'profile name',
    '账户1', 'a'.repeat(65),
  ])('rejects unsafe profile name %s', (name) => {
    expect(() => profilePath(name)).toThrow(/Invalid 1688 profile name/u);
  });
});
