import type { AccountFailoverResultV1 } from '@auto-ozon/contracts';

export interface AccountCollectionErrorV1 {
  code: string;
  message: string;
  recoverable: boolean;
}

export type AccountCollectionExecutorV1<T> = (
  profile: string,
  attempt: number,
) => Promise<T>;

export async function collectWithAccountFailover<T>(
  profiles: readonly string[],
  executor: AccountCollectionExecutorV1<T>,
  attemptsPerAccount = 3,
  options: { stop_on_error_codes?: readonly string[] } = {},
): Promise<AccountFailoverResultV1<T>> {
  if (profiles.length < 2) throw new Error('TWO_1688_PROFILES_REQUIRED');
  if (!Number.isSafeInteger(attemptsPerAccount) || attemptsPerAccount !== 3) {
    throw new Error('ATTEMPTS_PER_ACCOUNT_MUST_BE_THREE');
  }
  const attempts: AccountFailoverResultV1<T>['attempts'] = [];
  let finalErrorCode: string | null = null;
  for (const profile of profiles.slice(0, 2)) {
    for (let attempt = 1; attempt <= attemptsPerAccount; attempt += 1) {
      try {
        const value = await executor(profile, attempt);
        attempts.push({ profile, attempt, status: 'succeeded', error_code: null });
        return { status: 'succeeded', value, attempts, final_error_code: null };
      } catch (error) {
        finalErrorCode = normalizeErrorCode(error);
        attempts.push({ profile, attempt, status: 'failed', error_code: finalErrorCode });
        if (options.stop_on_error_codes?.includes(finalErrorCode)) {
          return { status: 'stopped', value: null, attempts, final_error_code: finalErrorCode };
        }
        if (typeof error === 'object' && error !== null && 'recoverable' in error && error.recoverable === false) {
          return { status: 'failed', value: null, attempts, final_error_code: finalErrorCode };
        }
      }
    }
  }
  return { status: 'skipped', value: null, attempts, final_error_code: finalErrorCode };
}

function normalizeErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') return error.code;
  return error instanceof Error && /^[A-Z][A-Z0-9_]+$/u.test(error.message) ? error.message : 'COLLECTION_FAILED';
}
