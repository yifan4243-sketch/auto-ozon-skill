import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectWithAccountFailover, runMarketSelection } from '../../../packages/market-selection/src/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('market selection', () => {
  it('accepts negative annual growth, diversifies roots and never leaks an absolute snapshot path', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'market-selection-'));
    temporaryDirectories.push(directory);
    const snapshotPath = path.join(directory, 'annual.json');
    const level3 = Array.from({ length: 12 }, (_, index) => ({
      level: 3,
      root_id: Math.floor(index / 2) + 1,
      root_label: `家居${Math.floor(index / 2) + 1}`,
      category_id: 1000 + index,
      category_name: `收纳用品${index}`,
      category_path: `家居${Math.floor(index / 2) + 1} > 收纳用品${index}`,
      metric_gmv: 100_000 + index * 10_000,
      metric_gmv_growth: index === 0 ? -5 : index + 1,
      metric_items: 1_000 + index * 100,
      metric_sellers: 30 + index,
      metric_buyout: 70,
      metric_leader_share: 10 + index,
    }));
    await fs.writeFile(snapshotPath, JSON.stringify({ captured_at: '2026-06-17T00:00:00Z', finished: true, stopped: false, level3 }));

    const result = await runMarketSelection({ batch_id: 'batch-1', snapshot_path: snapshotPath, category_count: 5 });

    expect(result.selected_categories).toHaveLength(5);
    expect(result.planned_listing_total).toBe(100);
    expect(Math.max(...Array.from(new Set(result.selected_categories.map((item) => item.root_category_id))).map(
      (root) => result.selected_categories.filter((item) => item.root_category_id === root).length,
    ))).toBeLessThanOrEqual(2);
    expect(path.isAbsolute(result.snapshot.path)).toBe(false);
    expect(JSON.stringify(result)).not.toContain('companyId');
    expect(result.rejected_categories.some((item) => item.analytics_category_id === 1000)).toBe(false);
  });
});

describe('1688 account failover', () => {
  it('tries account 1 three times, then account 2 and succeeds', async () => {
    const calls: string[] = [];
    const result = await collectWithAccountFailover(['account-1', 'account-2'], async (profile, attempt) => {
      calls.push(`${profile}:${attempt}`);
      if (profile === 'account-2' && attempt === 2) return 'offer';
      throw Object.assign(new Error('risk control'), { code: 'COLLECTION_RETRYABLE' });
    });
    expect(result.status).toBe('succeeded');
    expect(result.value).toBe('offer');
    expect(calls).toEqual(['account-1:1', 'account-1:2', 'account-1:3', 'account-2:1', 'account-2:2']);
  });

  it('skips only after both accounts fail three times', async () => {
    const result = await collectWithAccountFailover(['account-1', 'account-2'], async () => {
      throw Object.assign(new Error('failed'), { code: 'COLLECTION_FAILED' });
    });
    expect(result.status).toBe('skipped');
    expect(result.attempts).toHaveLength(6);
    expect(result.final_error_code).toBe('COLLECTION_FAILED');
  });
});
