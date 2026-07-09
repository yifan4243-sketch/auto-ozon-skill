import { randomUUID } from 'node:crypto';
import type { BrowserContext } from 'playwright';
import { withSession } from './context.js';
import { defaultProfileName } from './paths.js';
import {
  appendEventBestEffort,
  endEvent,
  eventFromError,
  startEvent,
} from './events.js';

export interface DispatchOpts {
  headed?: boolean;
  profile?: string;
}

type Executor<TArgs, TData> = (
  ctx: BrowserContext,
  args: TArgs,
) => Promise<TData>;

const REGISTRY: Record<string, () => Promise<Executor<unknown, unknown>>> = {
  search: () =>
    import('../commands/search.js').then((m) => m.execute as Executor<unknown, unknown>),
  whoami: () =>
    import('../commands/whoami.js').then((m) => m.execute as Executor<unknown, unknown>),
  offers: () =>
    import('../commands/offers.js').then(
      (m) => m.execute as Executor<unknown, unknown>,
    ),
  'image-search': () =>
    import('../commands/image-search.js').then(
      (m) => m.execute as Executor<unknown, unknown>,
    ),
  similar: () =>
    import('../commands/similar.js').then(
      (m) => m.execute as Executor<unknown, unknown>,
    ),
};

export async function loadExecutor<TArgs, TData>(
  name: string,
): Promise<Executor<TArgs, TData>> {
  const loader = REGISTRY[name];
  if (!loader) throw new Error(`Unknown command: ${name}`);
  return (await loader()) as Executor<TArgs, TData>;
}

export async function dispatch<TArgs, TData>(
  name: string,
  args: TArgs,
  opts: DispatchOpts = {},
): Promise<TData> {
  const profile = defaultProfileName(opts.profile);
  const requestId = makeRequestId();
  const startedAt = Date.now();
  await appendEventBestEffort(startEvent({ requestId, cmd: name, profile }));

  try {
    const fn = await loadExecutor<TArgs, TData>(name);
    const data = await withSession(
      { headless: !opts.headed, profile },
      (ctx) => fn(ctx, args),
      { requestId, cmd: name, args },
    );
    await appendEventBestEffort(
      endEvent({ requestId, cmd: name, startedAt, profile }),
    );
    return data;
  } catch (error) {
    await appendEventBestEffort(
      eventFromError({ requestId, cmd: name, startedAt, profile, error }),
    );
    throw error;
  }
}

function makeRequestId(): string {
  return `req_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}
