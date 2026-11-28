import { evaluatePricingWindow } from './routing-pricing.ts';
import type { GoEvidence } from '../types/kitto.d.ts';

interface PriceShape {
  price?: unknown;
  cache?: { read?: unknown; write?: unknown };
  overrides?: unknown;
}

interface GoMultiplier {
  factor?: number;
}

interface GoCatalogEntry {
  id?: string;
  canonical_id?: string;
  type?: string;
  go?: { training?: unknown; monthly_usage?: Record<string, unknown> };
  cost?: { text?: { input?: PriceShape; output?: PriceShape }; multipliers?: GoMultiplier[] };
  price?: unknown;
  cache?: { read?: unknown; write?: unknown };
  overrides?: unknown;
}

export type GoMeter =
  | { status: 'missing' | 'stale' | 'invalid' }
  | { status: 'exhausted'; windows: Array<{ name: string; resetsAt: string }> }
  | { status: 'available'; remaining: number; limitingWindow: string; resetsAt: string };

const WINDOWS: Record<string, number> = { rolling: 0.2, weekly: 0.5, monthly: 1 };
const PLANS = ['go', 'go-plus', 'go-teams'];
const SNAPSHOT_TTL = 5 * 60_000;
const CATALOG_TTL = 24 * 60 * 60_000;
const nonnegative = (value: unknown): value is number => Number.isFinite(value) && (value as number) >= 0;
export const timestamp = (value: unknown): number =>
  typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) ? Date.parse(value) : NaN;
export const fresh = (value: unknown, now: number, ttl: number) => {
  const time = timestamp(value);
  return Number.isFinite(time) && time <= now && now - time <= ttl;
};

interface GoWindow {
  name: string;
  percent: number;
  resetsAt: string;
  expired: boolean;
  exhausted: boolean;
  remaining: number;
}

export function goMeter(go: GoEvidence | null | undefined, now: number): GoMeter {
  const usage = go?.usage;
  if (!usage) return { status: 'missing' };
  if (!fresh(go.observedAt, now, SNAPSHOT_TTL)) return { status: 'stale' };
  const windows = Object.entries(WINDOWS).map(([name, share]): GoWindow | null => {
    const item = usage[name];
    if (
      !item ||
      !['ok', 'rate-limited'].includes(item.status) ||
      !Number.isInteger(item.percent) ||
      item.percent < 0 ||
      item.percent > 100 ||
      !Number.isFinite(timestamp(item.resetsAt))
    )
      return null;
    return {
      name,
      percent: item.percent,
      resetsAt: item.resetsAt,
      expired: timestamp(item.resetsAt) <= now,
      exhausted: item.status === 'rate-limited' || item.percent === 100,
      remaining: (Math.max(0, 99 - item.percent) * share) / 100,
    };
  });
  const valid = windows.filter((window): window is GoWindow => window !== null);
  const exhausted = valid.filter((window) => window.exhausted && !window.expired);
  if (exhausted.length) return { status: 'exhausted', windows: exhausted.map(({ name, resetsAt }) => ({ name, resetsAt })) };
  if (valid.length !== windows.length) return { status: 'invalid' };
  if (valid.some((window) => window.expired)) return { status: 'stale' };
  const tightest = valid.reduce((a, b) => (a.remaining <= b.remaining ? a : b));
  return { status: 'available', remaining: tightest.remaining, limitingWindow: tightest.name, resetsAt: tightest.resetsAt };
}

export function maxPrice(side: PriceShape | null | undefined): number {
  if (side?.overrides !== undefined && !Array.isArray(side.overrides)) return NaN;
  const prices: unknown[] = [];
  for (const entry of [side, ...(side?.overrides ?? [])]) {
    const cache = entry?.cache;
    prices.push(entry?.price);
    if (cache?.read !== undefined) prices.push(cache.read);
    if (cache?.write !== undefined)
      prices.push(
        ...(cache.write && typeof cache.write === 'object' && !Array.isArray(cache.write) ? Object.values(cache.write) : [cache.write]),
      );
  }
  return prices.every(nonnegative) ? Math.max(...(prices as number[])) : NaN;
}

export function goModel(go: GoEvidence | null | undefined, model: string, now: number): { item: GoCatalogEntry; cap: number } | null {
  const catalog = go?.catalog as { data?: unknown } | undefined;
  if (!go || !go.plan || !PLANS.includes(go.plan) || !fresh(go.catalogObservedAt, now, CATALOG_TTL) || !Array.isArray(catalog?.data))
    return null;
  const matches = (catalog.data as GoCatalogEntry[]).filter((item) => item?.id === model);
  if (matches.length !== 1 || matches[0].type !== 'chat' || matches[0].go?.training !== false) return null;
  const item = matches[0],
    cap = item.go?.monthly_usage?.[go.plan ?? ''];
  if (typeof cap !== 'number' || !Number.isFinite(cap) || cap <= 0) return null;
  return { item, cap };
}

const validMultipliers = (multipliers: readonly GoMultiplier[] | undefined): boolean =>
  multipliers === undefined ||
  (Array.isArray(multipliers) && multipliers.every((item: GoMultiplier) => Number.isFinite(item?.factor) && (item.factor ?? 0) > 0));

export function effectiveGoMultiplier(
  item: GoCatalogEntry,
  nowMs?: number,
  options?: { mode?: 'worst-case' | 'effective'; expectedDurationMinutes?: number; holidayOverrides?: readonly string[] },
): number | null {
  const multipliers = item.cost?.multipliers;
  if (!validMultipliers(multipliers)) return null;
  const worstCase = (multipliers ?? []).reduce((product: number, entry: GoMultiplier) => product * Math.max(1, entry.factor ?? 1), 1);
  if (options?.mode !== 'effective' || nowMs === undefined) return worstCase;
  return evaluatePricingWindow(item.canonical_id ?? '', nowMs, {
    expectedDurationMinutes: options.expectedDurationMinutes,
    holidayOverrides: options.holidayOverrides,
    remoteMultipliers: multipliers,
  }).effectiveMultiplier;
}

export function estimateGoFraction(
  { item, cap }: { item: GoCatalogEntry; cap: number },
  tokens: { input?: number; output?: number } | null | undefined,
  options?: { now?: number; mode?: 'worst-case' | 'effective'; expectedDurationMinutes?: number; holidayOverrides?: readonly string[] },
): number | null {
  const inputTokens = tokens?.input,
    outputTokens = tokens?.output;
  if (
    typeof inputTokens !== 'number' ||
    !Number.isSafeInteger(inputTokens) ||
    inputTokens <= 0 ||
    typeof outputTokens !== 'number' ||
    !Number.isSafeInteger(outputTokens) ||
    outputTokens <= 0
  )
    return null;
  const input = maxPrice(item.cost?.text?.input),
    output = maxPrice(item.cost?.text?.output),
    factor = effectiveGoMultiplier(item, options?.now, options);
  if (!nonnegative(input) || !nonnegative(output) || input + output === 0 || factor === null) return null;
  const fraction = ((input * inputTokens + output * outputTokens) * factor) / (1_000_000 * cap);
  return Number.isFinite(fraction) && fraction > 0 ? fraction : null;
}

export function normalizeGoCharge(
  usage: { opencode?: { billing_source?: unknown; allowance?: unknown; list_cost?: unknown } } | null | undefined,
  { cap }: { cap: number },
  plan: string,
): { fraction: number; source: string } | null {
  if (!PLANS.includes(plan) || !Number.isFinite(cap) || cap <= 0) return null;
  const cost = usage?.opencode,
    billing = cost?.billing_source;
  if (
    (plan === 'go-plus' && billing !== 'go-plus') ||
    (plan === 'go' && billing !== 'go') ||
    (plan === 'go-teams' && !['go', 'go-teams'].includes(billing as string))
  )
    return null;
  if (!cost) return null;
  if (Object.hasOwn(cost, 'allowance')) return nonnegative(cost.allowance) ? { fraction: cost.allowance / cap, source: 'allowance' } : null;
  return nonnegative(cost.list_cost) ? { fraction: cost.list_cost / cap, source: 'list-cost-estimate' } : null;
}
