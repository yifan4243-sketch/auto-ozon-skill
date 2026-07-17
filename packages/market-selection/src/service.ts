import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { MarketSelectionV1, SelectedMarketCategoryV1 } from '@auto-ozon/contracts';

interface AnalyticsRow {
  level: number;
  root_id: number;
  root_label: string;
  category_id: number;
  category_name: string;
  category_path: string;
  metric_gmv: number | string;
  metric_gmv_growth: number | string;
  metric_items: number | string;
  metric_sellers: number | string;
  metric_buyout: number | string;
  metric_leader_share: number | string;
}

interface AnalyticsSnapshot {
  captured_at: string;
  finished: boolean;
  stopped: boolean;
  level3: AnalyticsRow[];
}

export interface RunMarketSelectionInputV1 {
  batch_id: string;
  snapshot_path: string;
  selection_date?: string;
  category_count?: number;
  daily_listing_limit?: number;
  max_sku_per_product?: number;
}

const EXCLUDED_ROOTS = /Fresh|食品|药店|成人用品|吸烟|服务|慈善|书籍|电子产品|家用电器/iu;
const EXCLUDED_CATEGORY = /药|食品|饮料|奶|肉|鱼|电池|蓄电池|液体|香水|化妆|医疗|消毒|杀虫|烟|电子烟|酒|认证|婴儿配方|大型家具|轮胎|机油/iu;

export async function runMarketSelection(input: RunMarketSelectionInputV1): Promise<MarketSelectionV1> {
  validateInput(input);
  const absolute = path.resolve(input.snapshot_path);
  const bytes = await fs.readFile(absolute);
  const snapshot = JSON.parse(bytes.toString('utf8')) as AnalyticsSnapshot;
  if (!snapshot.finished || snapshot.stopped || !Array.isArray(snapshot.level3)) throw new Error('MARKET_SNAPSHOT_INCOMPLETE');
  const selectionDate = input.selection_date ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(selectionDate) || Number.isNaN(Date.parse(`${selectionDate}T00:00:00Z`))) throw new Error('SELECTION_DATE_INVALID');
  const rejected: MarketSelectionV1['rejected_categories'] = [];
  const viable: AnalyticsRow[] = [];
  for (const row of snapshot.level3) {
    const incomplete = !completeMetric(row);
    const reason = incomplete ? '关键年度指标不完整'
      : EXCLUDED_ROOTS.test(row.root_label) ? `一级类目不适合当前跨境小卖家策略：${row.root_label}`
      : EXCLUDED_CATEGORY.test(`${row.category_name} ${row.category_path}`) ? '商品通常涉及食品、液体、电池、认证、时效或超大件风险'
      : null;
    if (reason) rejected.push({ analytics_category_id: Number(row.category_id) || 0, reason });
    else viable.push(row);
  }
  if (viable.length === 0) throw new Error('NO_VIABLE_MARKET_CATEGORIES');
  const scored = viable.map((row) => scoreRow(row, viable, selectionDate)).sort((a, b) => b.score - a.score || a.analytics_category_id - b.analytics_category_id);
  const count = input.category_count ?? 8;
  const selected: ReturnType<typeof scoreRow>[] = [];
  const perRoot = new Map<number, number>();
  for (const candidate of scored) {
    if ((perRoot.get(candidate.root_category_id) ?? 0) >= 2) continue;
    selected.push(candidate);
    perRoot.set(candidate.root_category_id, (perRoot.get(candidate.root_category_id) ?? 0) + 1);
    if (selected.length === count) break;
  }
  if (selected.length < count) throw new Error('CATEGORY_DIVERSITY_TARGET_UNREACHABLE');
  const dailyLimit = input.daily_listing_limit ?? 100;
  const cap = count <= 7 ? 15 : count >= 9 ? 10 : 12;
  const base = Math.min(cap, Math.floor(dailyLimit / count));
  let remaining = Math.min(dailyLimit, base * count);
  const final = selected.map((category): SelectedMarketCategoryV1 => {
    const planned = Math.min(base, remaining);
    remaining -= planned;
    return { ...category, planned_listings: planned, candidate_collection_target: planned * 2, max_sku_per_product: input.max_sku_per_product ?? 3 };
  });
  return {
    schema_version: 1,
    batch_id: input.batch_id,
    snapshot: { path: portableSnapshotPath(absolute), sha256: crypto.createHash('sha256').update(bytes).digest('hex'), captured_at: snapshot.captured_at },
    selection_date: selectionDate,
    daily_listing_limit: dailyLimit,
    planned_listing_total: final.reduce((sum, item) => sum + item.planned_listings, 0),
    selected_categories: final,
    rejected_categories: rejected,
  };
}

function scoreRow(row: AnalyticsRow, rows: AnalyticsRow[], selectionDate: string) {
  const gmv = Number(row.metric_gmv); const items = Number(row.metric_items); const growth = Number(row.metric_gmv_growth);
  const sellers = Number(row.metric_sellers); const buyout = Number(row.metric_buyout); const leader = Number(row.metric_leader_share);
  const demandGmv = percentile(gmv, rows.map((item) => Number(item.metric_gmv)));
  const demandItems = percentile(items, rows.map((item) => Number(item.metric_items)));
  const positiveGrowth = percentile(Math.max(0, growth), rows.map((item) => Math.max(0, Number(item.metric_gmv_growth))));
  const sellerPercentile = percentile(sellers, rows.map((item) => Number(item.metric_sellers)));
  const moderateCompetition = Math.max(0, 1 - Math.abs(sellerPercentile - 0.5) * 2);
  const longTail = demandGmv >= 0.2 && demandGmv < 0.8 && growth > 0 && items > 0 ? 1 : 0;
  const seasonal = seasonalAdjustment(row, selectionDate);
  const rawScore = 25 * demandGmv + 15 * demandItems + 15 * positiveGrowth
    + 20 * (1 - clamp(leader / 100, 0, 1)) + 10 * clamp(buyout / 100, 0, 1)
    + 10 * moderateCompetition + 5 * longTail + seasonal.adjustment;
  const score = round(clamp(rawScore, 0, 100));
  return {
    analytics_category_id: Number(row.category_id), root_category_id: Number(row.root_id), root_category_name_zh: row.root_label,
    category_path_zh: row.category_path, search_keyword_1688_zh: row.category_name, score,
    metrics: { gmv, items, growth_percent: growth, seller_count: sellers, buyout_percent: buyout, leader_share_percent: leader },
    seasonal_adjustment: seasonal.adjustment, seasonal_reason_zh: seasonal.reason,
    rationale_zh: `年度需求分位与增长、头部卖家份额${round(leader)}%、卖家竞争度和买断率共同评分；${seasonal.reason}`,
  };
}

function seasonalAdjustment(row: AnalyticsRow, selectionDate: string): { adjustment: number; reason: string } {
  const month = Number(selectionDate.slice(5, 7));
  const text = `${row.category_name} ${row.category_path}`;
  const rules = month <= 2 || month >= 11
    ? [{ pattern: /保暖|雪|滑雪|圣诞|新年|热水|冬/iu, value: 8, reason: '俄罗斯冬季与新年消费场景直接相关' }]
    : month <= 5
      ? [{ pattern: /园艺|花园|雨|清洁|收纳/iu, value: 6, reason: '春季园艺、清洁和换季收纳场景相关' }]
      : month <= 8
        ? [{ pattern: /户外|露营|旅行|野餐|水杯|饮水|花园|防晒|游泳/iu, value: 6, reason: '夏季户外、旅行和花园使用场景相关' }]
        : [{ pattern: /文具|学习|收纳|雨|照明/iu, value: 5, reason: '返校和秋季居家场景相关' }];
  const matched = rules.find((rule) => rule.pattern.test(text));
  return matched ? { adjustment: matched.value, reason: matched.reason } : { adjustment: 0, reason: '没有使用未经数据支持的季节加分' };
}

function completeMetric(row: AnalyticsRow): boolean {
  const nonNegative = [row.metric_gmv, row.metric_items, row.metric_sellers, row.metric_buyout, row.metric_leader_share];
  return row.level === 3 && Number.isSafeInteger(Number(row.category_id)) && Number(row.category_id) > 0
    && Boolean(row.category_name?.trim()) && Boolean(row.category_path?.trim())
    && nonNegative
      .every((value) => value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0)
    && row.metric_gmv_growth !== '' && Number.isFinite(Number(row.metric_gmv_growth));
}

function percentile(value: number, values: number[]): number {
  if (values.length <= 1) return 1;
  const below = values.filter((candidate) => candidate < value).length;
  const equal = values.filter((candidate) => candidate === value).length;
  return (below + Math.max(0, equal - 1) / 2) / (values.length - 1);
}

function validateInput(input: RunMarketSelectionInputV1): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(input.batch_id)) throw new Error('BATCH_ID_INVALID');
  const count = input.category_count ?? 8;
  if (!Number.isSafeInteger(count) || count < 5 || count > 10) throw new Error('CATEGORY_COUNT_MUST_BE_5_TO_10');
  const limit = input.daily_listing_limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < count || limit > 100) throw new Error('DAILY_LISTING_LIMIT_INVALID');
  const maxSku = input.max_sku_per_product ?? 3;
  if (!Number.isSafeInteger(maxSku) || maxSku < 1) throw new Error('MAX_SKU_INVALID');
}

function portableSnapshotPath(absolute: string): string {
  const relative = path.relative(process.cwd(), absolute);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return normalizePath(relative);
  return `external/${path.basename(absolute)}`;
}
function normalizePath(value: string): string { return value.replaceAll('\\', '/'); }
function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }
function round(value: number): number { return Math.round(value * 100) / 100; }
