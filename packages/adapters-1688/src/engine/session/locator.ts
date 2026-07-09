import type { Locator, Page } from 'playwright';
import { CliError } from '../io/errors.js';
import { waitForTruthy } from './wait.js';

export type LocatorCandidate =
  | { kind: 'role'; role: Parameters<Page['getByRole']>[0]; name: string | RegExp }
  | { kind: 'text'; text: string | RegExp }
  | { kind: 'css'; selector: string };

export interface StableLocatorOptions {
  description: string;
  timeoutMs?: number;
  requireVisible?: boolean;
  requireEnabled?: boolean;
  scrollIntoView?: boolean;
}

export interface StableLocatorResult {
  strategy: string;
  description: string;
}

export function locatorCandidateToDebugString(candidate: LocatorCandidate): string {
  switch (candidate.kind) {
    case 'role':
      return `role=${candidate.role} name=${String(candidate.name)}`;
    case 'text':
      return `text=${String(candidate.text)}`;
    case 'css':
      return `css=${candidate.selector}`;
  }
}

function locatorFor(page: Page, candidate: LocatorCandidate): Locator {
  switch (candidate.kind) {
    case 'role':
      return page.getByRole(candidate.role, { name: candidate.name }).first();
    case 'text':
      return page.getByText(candidate.text).first();
    case 'css':
      return page.locator(candidate.selector).first();
  }
}

async function isLocatorUsable(
  locator: Locator,
  opts: StableLocatorOptions,
): Promise<boolean> {
  const requireVisible = opts.requireVisible ?? true;
  const requireEnabled = opts.requireEnabled ?? true;
  if (requireVisible && !(await locator.isVisible().catch(() => false))) {
    return false;
  }
  if (requireEnabled && !(await locator.isEnabled().catch(() => false))) {
    return false;
  }
  return true;
}

export async function findVisible(
  page: Page,
  candidates: LocatorCandidate[],
  opts: StableLocatorOptions,
): Promise<Locator> {
  return findUsable(page, candidates, { ...opts, requireVisible: true });
}

export async function findClickable(
  page: Page,
  candidates: LocatorCandidate[],
  opts: StableLocatorOptions,
): Promise<Locator> {
  return findUsable(page, candidates, {
    ...opts,
    requireVisible: true,
    requireEnabled: true,
  });
}

async function findUsable(
  page: Page,
  candidates: LocatorCandidate[],
  opts: StableLocatorOptions,
): Promise<Locator> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const strategies = candidates.map(locatorCandidateToDebugString);
  const locator = await waitForTruthy(
    async () => {
      for (const candidate of candidates) {
        const candidateLocator = locatorFor(page, candidate);
        if (await isLocatorUsable(candidateLocator, opts)) {
          if (opts.scrollIntoView ?? true) {
            await candidateLocator
              .scrollIntoViewIfNeeded({ timeout: 1000 })
              .catch(() => {});
          }
          return candidateLocator;
        }
      }
      return null;
    },
    { timeoutMs, intervalMs: 200 },
  );

  if (locator) return locator;

  throw new CliError(
    14,
    'STABLE_LOCATOR_NOT_FOUND',
    `Could not locate ${opts.description}.`,
    {
      category: 'locator',
      locatorDescription: opts.description,
      locatorStrategies: strategies,
      currentUrl: page.url(),
      retryable: true,
    },
  );
}

export async function clickStable(
  page: Page,
  candidates: LocatorCandidate[],
  opts: StableLocatorOptions,
): Promise<StableLocatorResult> {
  const locator = await findClickable(page, candidates, opts);
  try {
    await locator.click({ timeout: opts.timeoutMs ?? 5000 });
    return {
      strategy: candidates.map(locatorCandidateToDebugString).join(' | '),
      description: opts.description,
    };
  } catch (e) {
    throw new CliError(
      14,
      'STABLE_LOCATOR_BLOCKED',
      `Located ${opts.description}, but it was not clickable: ${(e as Error).message}`,
      {
        category: 'locator',
        locatorDescription: opts.description,
        locatorStrategies: candidates.map(locatorCandidateToDebugString),
        currentUrl: page.url(),
        retryable: true,
      },
    );
  }
}
