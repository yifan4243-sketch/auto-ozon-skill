import type { Page } from 'playwright';
import { clickStable, findVisible } from './locator.js';

const NEXT_PAGE_SELECTOR = '.fui-arrow.fui-next:not(.fui-next-disabled)';

export async function clickSearchNextPage(page: Page): Promise<boolean> {
  const next = await findVisible(
    page,
    [{ kind: 'css', selector: NEXT_PAGE_SELECTOR }],
    {
      description: 'search next page button',
      timeoutMs: 1000,
    },
  ).catch(() => null);
  if (!next) return false;

  await clickStable(
    page,
    [{ kind: 'css', selector: NEXT_PAGE_SELECTOR }],
    {
      description: 'search next page button',
      timeoutMs: 5000,
    },
  );
  return true;
}
