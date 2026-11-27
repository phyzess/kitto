import { authorizeGoRead, knownGoCanonical } from './model-routing.ts';
import { maxPrice, timestamp } from './go-allowance.ts';
import { routeId } from './routing-policy.ts';

const BASE = 'https://opencode.ai/inference/go/v1';
const MAX_BYTES = 512 * 1024;
const WINDOW_NAMES = ['rolling', 'weekly', 'monthly'];
const stopped = (reason, statusCode) => ({ status: 'stop', reason, ...(statusCode && { statusCode }) });

async function readMetadata(fetcher, name, headers, signal) {
  const response = await fetcher(`${BASE}/${name}`, { method: 'GET', headers, signal, redirect: 'error', credentials: 'omit' });
  if (response.redirected || response.status >= 300 && response.status < 400) return stopped('metadata-redirect', response.status);
  if (response.status !== 200) return stopped('metadata-http-error', response.status);
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body) return stopped('metadata-invalid');
  if (Number(response.headers.get('content-length')) > MAX_BYTES) return stopped('metadata-too-large');
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0, text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) { void reader.cancel().catch(() => {}); return stopped('metadata-too-large'); }
    try { text += decoder.decode(value, { stream: true }); } catch { return stopped('metadata-invalid'); }
  }
  try { return { value: JSON.parse(text + decoder.decode()) }; }
  catch { return stopped('metadata-invalid'); }
}

function catalogProjection(response, binding) {
  if (response?.object !== 'list' || !Array.isArray(response.data)) return null;
  const seen = new Set();
  for (const item of response.data) {
    if (!routeId(item?.id) || seen.has(item.id)) return null;
    seen.add(item.id);
  }
  const data = response.data.flatMap(item => {
    const verified = projectModel(item, binding.plan);
    return verified ? [verified] : [];
  });
  return data.some(item => item.id === binding.model && item.canonical_id === binding.canonicalModel) ? { object: 'list', data } : null;
}

function projectModel(item, plan) {
  const canonical = knownGoCanonical(item.id), cap = item.go?.monthly_usage?.[plan];
  if (!canonical || item.type !== 'chat' || typeof item.canonical_id !== 'string' || item.canonical_id.toLowerCase() !== canonical
    || item.go?.training !== false || !Number.isFinite(cap) || cap <= 0) return null;
  const input = maxPrice(item.cost?.text?.input), output = maxPrice(item.cost?.text?.output);
  const multipliers = item.cost?.multipliers === undefined ? [] : item.cost.multipliers;
  if (!Number.isFinite(input) || !Number.isFinite(output) || input + output <= 0 || !Array.isArray(multipliers)
    || !multipliers.every(row => Number.isFinite(row?.factor) && row.factor > 0)
    || !Number.isFinite(multipliers.reduce((product, row) => product * Math.max(1, row.factor), 1))) return null;
  return { id: item.id, canonical_id: canonical, type: 'chat',
    go: { monthly_usage: { [plan]: cap }, training: false },
    cost: { text: { input: { price: input }, output: { price: output } }, multipliers: multipliers.map(({ factor }) => ({ factor })) } };
}

function usageProjection(response, now) {
  const windows = [];
  for (const name of WINDOW_NAMES) {
    const item = response?.usage?.[name];
    if (!['ok', 'rate-limited'].includes(item?.status) || !Number.isInteger(item.percent) || item.percent < 0 || item.percent > 100
      || !(timestamp(item.resetsAt) > now)) return null;
    windows.push([name, { status: item.status, percent: item.percent, resetsAt: item.resetsAt }]);
  }
  return Object.fromEntries(windows);
}

export async function collectGoMetadata({ state, request, optedIn, fetcher = globalThis.fetch,
  readKey = () => process.env.KITTO_GO_METADATA_KEY, clock = Date.now, timeoutMs = 10_000 }) {
  if (optedIn !== true) return stopped('metadata-opt-in-required');
  const binding = authorizeGoRead(state, request, clock());
  if (!binding) return stopped('metadata-account-or-policy-unverified');
  let key;
  try { key = readKey(); } catch { return stopped('metadata-key-unavailable'); }
  if (typeof key !== 'string' || !/^[a-zA-Z0-9_.~-]{1,1024}$/.test(key)) return stopped('metadata-key-unavailable');
  const controller = new AbortController();
  let timer;
  try {
    const deadline = new Promise(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve(stopped('metadata-timeout')); }, Math.min(10_000, timeoutMs));
    });
    const collection = async () => {
      const headers = { Accept: 'application/json' };
      const models = await readMetadata(fetcher, 'models', headers, controller.signal);
      if (models.status === 'stop') return models;
      const catalog = catalogProjection(models.value, binding);
      if (!catalog) return stopped('metadata-catalog-unverified');
      const catalogObservedAt = new Date(clock()).toISOString();
      controller.signal.throwIfAborted();
      const meter = await readMetadata(fetcher, 'usage', { ...headers, Authorization: `Bearer ${key}` }, controller.signal);
      if (meter.status === 'stop') return meter;
      const now = clock(), usage = usageProjection(meter.value, now);
      if (!usage) return stopped('metadata-meter-unverified');
      return { status: 'collected', source: 'opencode-go-metadata', account: binding.account, plan: binding.plan,
        profile: binding.profile, catalogObservedAt, observedAt: new Date(now).toISOString(), catalog, usage };
    };
    return await Promise.race([deadline, collection()]);
  } catch {
    return stopped(controller.signal.aborted ? 'metadata-timeout' : 'metadata-transport-error');
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
