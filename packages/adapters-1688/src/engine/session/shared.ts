import type { BrowserContext } from 'playwright';
import { defaultProfileName } from './paths.js';
import { withSession } from './context.js';
import type { RunMeta } from './artifacts.js';

let opChain: Promise<unknown> = Promise.resolve();

export interface SharedContextStatus {
  profile: string | null;
  browserAlive: boolean;
  pageCount: number;
  currentUrl: string | null;
  pageState: null;
  loggedIn: null;
}

export async function getSharedContext(): Promise<BrowserContext> {
  throw new Error('Shared persistent context is not available in inline-only mode.');
}

export async function runOnSharedCtx<T>(
  fn: (ctx: BrowserContext) => Promise<T>,
  meta?: RunMeta,
  profile?: string,
): Promise<T> {
  const profileName = defaultProfileName(profile);
  const prev = opChain;
  let resolveOp!: (value: T) => void;
  let rejectOp!: (reason: unknown) => void;
  const opPromise = new Promise<T>((resolve, reject) => {
    resolveOp = resolve;
    rejectOp = reject;
  });
  opChain = prev.then(async () => {
    try {
      resolveOp(
        await withSession(
          { headless: true, profile: profileName },
          (ctx) => fn(ctx),
          meta,
        ),
      );
    } catch (error) {
      rejectOp(error);
    }
  });
  return opPromise;
}

export async function getSharedContextStatus(): Promise<SharedContextStatus> {
  return {
    profile: null,
    browserAlive: false,
    pageCount: 0,
    currentUrl: null,
    pageState: null,
    loggedIn: null,
  };
}

export async function releaseSharedContext(): Promise<void> {
  await opChain.catch(() => {});
}
