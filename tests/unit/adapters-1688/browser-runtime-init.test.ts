import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BROWSER_RUNTIME_INIT_SCRIPT } from '../../../packages/adapters-1688/src/engine/session/context.js';

describe('1688 browser runtime init script', () => {
  it('provides the esbuild __name helper used by serialized page.evaluate callbacks', () => {
    const sandbox = {
      navigator: {},
    } as Record<string, unknown>;
    vm.createContext(sandbox);

    vm.runInContext(BROWSER_RUNTIME_INIT_SCRIPT, sandbox);

    const result = vm.runInContext(
      `(() => {
        const readCategoryCandidate = __name((value) => [value], 'readCategoryCandidate');
        return {
          values: readCategoryCandidate('杯子'),
          helperName: readCategoryCandidate.name,
          languages: navigator.languages,
        };
      })()`,
      sandbox,
    ) as {
      values: string[];
      helperName: string;
      languages: string[];
    };

    expect(result.values).toEqual(['杯子']);
    expect(result.helperName).toBe('readCategoryCandidate');
    expect(result.languages).toEqual(['zh-CN', 'zh', 'en']);
  });

  it('does not replace an existing __name implementation', () => {
    const existing = (target: unknown) => target;
    const sandbox = {
      navigator: {},
      __name: existing,
    } as Record<string, unknown>;
    vm.createContext(sandbox);

    vm.runInContext(BROWSER_RUNTIME_INIT_SCRIPT, sandbox);

    expect(sandbox.__name).toBe(existing);
  });
});
