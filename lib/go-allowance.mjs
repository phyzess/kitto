const WINDOWS = { rolling: 0.2, weekly: 0.5, monthly: 1 };
const PLANS = ['go', 'go-plus', 'go-teams'];
const SNAPSHOT_TTL = 5 * 60_000;
const CATALOG_TTL = 24 * 60 * 60_000;
const nonnegative = value => Number.isFinite(value) && value >= 0;
export const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value)
  ? Date.parse(value) : NaN;
export const fresh = (value, now, ttl) => {
  const time = timestamp(value);
  return Number.isFinite(time) && time <= now && now - time <= ttl;
};

export function goMeter(go, now) {
  if (!go?.usage) return { status: 'missing' };
  if (!fresh(go.observedAt, now, SNAPSHOT_TTL)) return { status: 'stale' };
  const windows = Object.entries(WINDOWS).map(([name, share]) => {
    const item = go.usage[name];
    if (!item || !['ok', 'rate-limited'].includes(item.status) || !Number.isInteger(item.percent)
        || item.percent < 0 || item.percent > 100 || !Number.isFinite(timestamp(item.resetsAt))) return null;
    return { name, percent: item.percent, resetsAt: item.resetsAt, expired: timestamp(item.resetsAt) <= now,
      exhausted: item.status === 'rate-limited' || item.percent === 100,
      remaining: Math.max(0, 99 - item.percent) * share / 100 };
  });
  const exhausted = windows.filter(window => window?.exhausted && !window.expired);
  if (exhausted.length) return { status: 'exhausted', windows: exhausted.map(({ name, resetsAt }) => ({ name, resetsAt })) };
  if (windows.some(window => window === null)) return { status: 'invalid' };
  if (windows.some(window => window.expired)) return { status: 'stale' };
  const tightest = windows.reduce((a, b) => a.remaining <= b.remaining ? a : b);
  return { status: 'available', remaining: tightest.remaining, limitingWindow: tightest.name, resetsAt: tightest.resetsAt };
}

export function maxPrice(side) {
  if (side?.overrides !== undefined && !Array.isArray(side.overrides)) return NaN;
  const prices = [];
  for (const entry of [side, ...(side?.overrides ?? [])]) {
    const cache = entry?.cache;
    prices.push(entry?.price);
    if (cache?.read !== undefined) prices.push(cache.read);
    if (cache?.write !== undefined) prices.push(...(cache.write && typeof cache.write === 'object' && !Array.isArray(cache.write)
      ? Object.values(cache.write) : [cache.write]));
  }
  return prices.every(nonnegative) ? Math.max(...prices) : NaN;
}

export function goModel(go, model, now) {
  if (!PLANS.includes(go?.plan) || !fresh(go.catalogObservedAt, now, CATALOG_TTL) || !Array.isArray(go.catalog?.data)) return null;
  const matches = go.catalog.data.filter(item => item?.id === model);
  if (matches.length !== 1 || matches[0].type !== 'chat' || matches[0].go?.training !== false) return null;
  const item = matches[0], cap = item.go.monthly_usage?.[go.plan];
  if (!Number.isFinite(cap) || cap <= 0) return null;
  return { item, cap };
}

export function estimateGoFraction({ item, cap }, tokens) {
  if (!Number.isSafeInteger(tokens?.input) || tokens.input <= 0 || !Number.isSafeInteger(tokens?.output) || tokens.output <= 0) return null;
  const input = maxPrice(item.cost?.text?.input), output = maxPrice(item.cost?.text?.output);
  const multipliers = item.cost?.multipliers;
  if (!nonnegative(input) || !nonnegative(output) || input + output === 0
      || (multipliers !== undefined && (!Array.isArray(multipliers) || !multipliers.every(item => Number.isFinite(item?.factor) && item.factor > 0)))) return null;
  const factor = (multipliers ?? []).reduce((product, item) => product * Math.max(1, item.factor), 1);
  const fraction = (input * tokens.input + output * tokens.output) * factor / (1_000_000 * cap);
  return Number.isFinite(fraction) && fraction > 0 ? fraction : null;
}

export function normalizeGoCharge(usage, { cap }, plan) {
  if (!PLANS.includes(plan) || !Number.isFinite(cap) || cap <= 0) return null;
  const cost = usage?.opencode;
  const billing = cost?.billing_source;
  if ((plan === 'go-plus' && billing !== 'go-plus') || (plan === 'go' && billing !== 'go')
      || (plan === 'go-teams' && !['go', 'go-teams'].includes(billing))) return null;
  if (Object.hasOwn(cost, 'allowance')) return nonnegative(cost.allowance) ? { fraction: cost.allowance / cap, source: 'allowance' } : null;
  return nonnegative(cost.list_cost) ? { fraction: cost.list_cost / cap, source: 'list-cost-estimate' } : null;
}
