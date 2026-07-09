export async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export interface WaitUntilOptions {
  timeoutMs: number;
  intervalMs?: number;
}

export interface WaitDeadlineState {
  attempt: number;
  deadline: number;
  now: number;
  remainingMs: number;
}

export interface WaitWithDeadlineOptions<T> extends WaitUntilOptions {
  onTimeout: () => T | Promise<T>;
}

export interface WithTimeoutOptions<TFallback> {
  timeoutMs: number;
  fallback: TFallback;
}

export async function withTimeout<T, TFallback = T>(
  promise: Promise<T>,
  opts: WithTimeoutOptions<TFallback>,
): Promise<T | TFallback> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race<T | TFallback>([
      promise,
      new Promise<TFallback>((resolve) => {
        timer = setTimeout(() => resolve(opts.fallback), opts.timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function waitWithDeadline<T>(
  poll: (state: WaitDeadlineState) => T | null | undefined | Promise<T | null | undefined>,
  opts: WaitWithDeadlineOptions<T>,
): Promise<T> {
  const deadline = Date.now() + opts.timeoutMs;
  const intervalMs = opts.intervalMs ?? 250;
  let attempt = 0;
  while (true) {
    const now = Date.now();
    const remainingMs = Math.max(0, deadline - now);
    if (remainingMs <= 0) return opts.onTimeout();
    const result = await poll({ attempt, deadline, now, remainingMs });
    if (result !== null && result !== undefined) return result;
    attempt++;
    await sleep(Math.min(intervalMs, remainingMs));
  }
}

export async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  opts: WaitUntilOptions,
): Promise<boolean> {
  return waitWithDeadline(async () => ((await predicate()) ? true : null), {
    ...opts,
    onTimeout: () => false,
  });
}

export async function waitForTruthy<T>(
  probe: () => T | null | undefined | false | Promise<T | null | undefined | false>,
  opts: WaitUntilOptions,
): Promise<T | null> {
  return waitWithDeadline(async () => {
    const value = await probe();
    return value || null;
  }, {
    ...opts,
    onTimeout: () => null,
  });
}
