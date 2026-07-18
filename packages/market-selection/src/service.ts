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
  metric_gmv?: number | string | null;
  metric_gmv_growth?: number | string | null;
  metric_items?: number | string | null;
  metric_sellers?: number | string | null;
  metric_buyout?: number | string | null;
  metric_leader_share?: number | string | null;
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
    const identityInvalid = !validCategoryIdentity(row);
    const noMetrics = availableMetricCount(row) === 0;
    const reason = identityInvalid ? '类目身份字段不完整'
      : noMetrics ? '年度市场指标全部不可用'
      : EXCLUDED_ROOTS.test(row.root_label) ? `一级类目不适合当前跨境小卖家策略：${row.root_label}`
      : EXCLUDED_CATEGORY.test(`${row.category_name} ${row.category_path}`) ? '商品通常涉及食品、液体、电池、认证、时效或超大件风险'
      : null;
    if (reason) rejected.push({ analytics_category_id: Number(row.category_id) || 0, reason });
    else viable.push(row);
  }
  if (viable.length === 0) throw new Error('NO_VIABLE_MARKET_CATEGORIES');
  const distributions = {
    gmv: percentileLookup(viable.map((item) => nonNegativeMetric(item.metric_gmv)).filter(isNumber)),
    items: percentileLookup(viable.map((item) => nonNegativeMetric(item.metric_items)).filter(isNumber)),
    growth: percentileLookup(viable.map((item) => metric(item.metric_gmv_growth)).filter(isNumber).map((value) => Math.max(0, value))),
    sellers: percentileLookup(viable.map((item) => nonNegativeMetric(item.metric_sellers)).filter(isNumber)),
  };
  const scored = viable.map((row) => scoreRow(row, distributions, selectionDate)).sort((a, b) => b.score - a.score || a.analytics_category_id - b.analytics_category_id);
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
  const base = Math.floor(dailyLimit / count);
  const remainder = dailyLimit % count;
  const final = selected.map((category, index): SelectedMarketCategoryV1 => {
    const planned = base + (index < remainder ? 1 : 0);
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

function scoreRow(row: AnalyticsRow, distributions: ScoringDistributions, selectionDate: string) {
  const gmv = nonNegativeMetric(row.metric_gmv); const items = nonNegativeMetric(row.metric_items); const growth = metric(row.metric_gmv_growth);
  const sellers = nonNegativeMetric(row.metric_sellers); const buyout = nonNegativeMetric(row.metric_buyout); const leader = nonNegativeMetric(row.metric_leader_share);
  const demandGmv = gmv === null ? null : distributions.gmv(gmv);
  const demandItems = items === null ? null : distributions.items(items);
  const positiveGrowth = growth === null ? null : distributions.growth(Math.max(0, growth));
  const sellerPercentile = sellers === null ? null : distributions.sellers(sellers);
  const moderateCompetition = sellerPercentile === null ? null : Math.max(0, 1 - Math.abs(sellerPercentile - 0.5) * 2);
  const smallSellerOpportunity = leader === null ? null : 1 - clamp(leader / 100, 0, 1);
  const buyoutScore = buyout === null ? null : clamp(buyout / 100, 0, 1);
  const longTail = demandGmv === null || growth === null || items === null
    ? null
    : demandGmv >= 0.2 && demandGmv < 0.8 && growth > 0 && items > 0 ? 1 : 0;
  const seasonal = seasonalAdjustment(row, selectionDate);
  const weighted = [
    component('demand_gmv', demandGmv, 25), component('demand_items', demandItems, 15),
    component('growth', positiveGrowth, 15), component('small_seller_opportunity', smallSellerOpportunity, 20),
    component('buyout', buyoutScore, 10), component('competition_balance', moderateCompetition, 10),
    component('long_tail', longTail, 5),
  ].filter((value): value is { name: string; score: number; weight: number } => value !== null);
  const availableWeight = weighted.reduce((sum, value) => sum + value.weight, 0);
  const normalized = availableWeight > 0
    ? weighted.reduce((sum, value) => sum + value.score * value.weight, 0) / availableWeight * 100
    : 0;
  const score = round(clamp(normalized + seasonal.adjustment, 0, 100));
  const unavailable = [
    ...(demandGmv === null ? ['demand_gmv'] : []), ...(demandItems === null ? ['demand_items'] : []),
    ...(positiveGrowth === null ? ['growth'] : []), ...(smallSellerOpportunity === null ? ['small_seller_opportunity'] : []),
    ...(moderateCompetition === null ? ['competition_balance'] : []), ...(buyoutScore === null ? ['buyout'] : []),
    ...(longTail === null ? ['long_tail'] : []), 'profit', 'logistics', 'risk',
  ];
  return {
    analytics_category_id: Number(row.category_id), root_category_id: Number(row.root_id), root_category_name_zh: row.root_label,
    category_path_zh: row.category_path, search_keyword_1688_zh: row.category_name, score,
    metrics: { gmv, items, growth_percent: growth, seller_count: sellers, buyout_percent: buyout, leader_share_percent: leader },
    score_components: {
      demand_gmv: demandGmv === null ? null : round(demandGmv * 100),
      demand_items: demandItems === null ? null : round(demandItems * 100),
      growth: positiveGrowth === null ? null : round(positiveGrowth * 100),
      small_seller_opportunity: smallSellerOpportunity === null ? null : round(smallSellerOpportunity * 100),
      competition_balance: moderateCompetition === null ? null : round(moderateCompetition * 100),
      buyout: buyoutScore === null ? null : round(buyoutScore * 100),
      long_tail: longTail === null ? null : round(longTail * 100),
      seasonality: seasonal.adjustment, profit: null, logistics: null, risk: null,
    },
    unavailable_components: unavailable,
    seasonal_adjustment: seasonal.adjustment, seasonal_reason_zh: seasonal.reason,
    rationale_zh: `只使用可用年度指标并按实际可用权重重新归一；${leader === null ? '头部卖家份额不可用' : `头部卖家份额${round(leader)}%`}；${seasonal.reason}。利润、物流与商品风险等待1688商品事实后再评估。`,
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

function validCategoryIdentity(row: AnalyticsRow): boolean {
  return row.level === 3 && Number.isSafeInteger(Number(row.category_id)) && Number(row.category_id) > 0
    && Boolean(row.category_name?.trim()) && Boolean(row.category_path?.trim());
}

function availableMetricCount(row: AnalyticsRow): number {
  return [
    nonNegativeMetric(row.metric_gmv), nonNegativeMetric(row.metric_items),
    nonNegativeMetric(row.metric_sellers), nonNegativeMetric(row.metric_buyout),
    nonNegativeMetric(row.metric_leader_share), metric(row.metric_gmv_growth),
  ].filter(isNumber).length;
}

function metric(value: unknown): number | null {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonNegativeMetric(value: unknown): number | null {
  const number = metric(value);
  return number !== null && number >= 0 ? number : null;
}

function isNumber(value: number | null): value is number { return value !== null; }

function component(name: string, score: number | null, weight: number): { name: string; score: number; weight: number } | null {
  return score === null ? null : { name, score, weight };
}

interface ScoringDistributions {
  gmv: (value: number) => number; items: (value: number) => number;
  growth: (value: number) => number; sellers: (value: number) => number;
}

function percentileLookup(values: number[]): (value: number) => number {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) return () => 0;
  if (sorted.length <= 1) return () => 1;
  return (value: number) => {
    const below = lowerBound(sorted, value);
    const atOrBelow = upperBound(sorted, value);
    const equal = atOrBelow - below;
    return (below + Math.max(0, equal - 1) / 2) / (sorted.length - 1);
  };
}

function lowerBound(values: number[], target: number): number {
  let low = 0; let high = values.length;
  while (low < high) { const middle = Math.floor((low + high) / 2); if (values[middle]! < target) low = middle + 1; else high = middle; }
  return low;
}
function upperBound(values: number[], target: number): number {
  let low = 0; let high = values.length;
  while (low < high) { const middle = Math.floor((low + high) / 2); if (values[middle]! <= target) low = middle + 1; else high = middle; }
  return low;
}

function validateInput(input: RunMarketSelectionInputV1): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(input.batch_id)) throw new Error('BATCH_ID_INVALID');
  const count = input.category_count ?? 8;
  if (!Number.isSafeInteger(count) || count < 5 || count > 10) throw new Error('CATEGORY_COUNT_MUST_BE_5_TO_10');
  const limit = input.daily_listing_limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('DAILY_LISTING_LIMIT_INVALID');
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
