import { readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, sep } from 'node:path';
import { createRouteObserver } from './dsh-route-evidence.mjs';
import { timestamp } from '../lib/go-allowance.mjs';
import { kittoHome } from '../lib/kitto-home.mjs';
import { adviseRoute } from '../lib/model-routing.mjs';
import { activeRoutingBoundary, routeId } from '../lib/routing-policy.mjs';
import { createRoutingStore, newTicketId, ticketId } from '../lib/routing-state.mjs';

export const ROUTING_HOST_VERSION = '0.2.2-rc.5';
const TTL = 120_000;
const OBSERVATION_TTL = 300_000;
const unsupported = 'Kitto requires a fresh operator permit and native one-time approval for this subagent call.';
const deny = () => ({ kind: 'deny', reason: unsupported, info: { code: 'KITTO_ROUTE_DENIED' } });

function directory(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || !statSync(path).isDirectory()) throw new Error('Invalid routing directory.');
  return realpathSync(path);
}

export function boundRoutingPolicy(state, home, profile = 'web') {
  try {
    return profile === 'web' && directory(state?.dshHome) === directory(home) && activeRoutingBoundary(state, profile) || null;
  } catch { return null; }
}

export function issueRoutePermit({ state, home, request, store, now = Date.now() }) {
  const { host, task, dispatch, go } = request ?? {};
  const policy = boundRoutingPolicy(state, home, host?.profile);
  if (!policy || host?.surface !== 'subagent' || host.version !== ROUTING_HOST_VERSION
      || host.spawnVerified !== true || !Array.isArray(host.effectiveFallbacks) || host.effectiveFallbacks.length !== 0
      || dispatch?.source !== 'operator-verified' || !routeId(host.session) || !routeId(task?.id)
      || task.budget?.maxAdditionalCashUsd !== 0 || !Number.isFinite(task.budget.maxMonthlyGoFraction)
      || task.budget.maxMonthlyGoFraction < 0 || task.budget.maxMonthlyGoFraction > 1
      || request.failure !== undefined || request.attempted !== undefined) throw new Error('Unverified dispatch authorization, budget or host.');
  const project = directory(dispatch.project), callerCwd = directory(dispatch.callerCwd), cwd = directory(dispatch.cwd);
  for (const path of [callerCwd, cwd]) {
    const fromProject = relative(project, path);
    if (isAbsolute(fromProject) || fromProject === '..' || fromProject.startsWith(`..${sep}`)) throw new Error('Dispatch cannot leave the approved project.');
  }
  const result = adviseRoute({ state, request, now, poolStatus: (pool, meterAt) => store.poolStatus(pool, now, meterAt), controlled: true });
  if (result.status !== 'recommend') throw new Error(`Dispatch preflight stopped: ${result.reason}.`);
  const { provider, model, reasoning_effort, canonicalModel } = result.route;
  const route = host.routes.find(row => row.provider === provider && row.model === model);
  const selected = { provider, model, canonicalModel, upstream: route.upstream, account: route.account, billing: route.billing };
  let pool, meterAt, expiresAt = Math.min(now + TTL, timestamp(host.observedAt) + OBSERVATION_TTL);
  if (route.upstream === 'opencode-go') {
    pool = go.pool;
    const data = go.metadata ?? go;
    meterAt = data.observedAt;
    expiresAt = Math.min(expiresAt, timestamp(data.observedAt) + OBSERVATION_TTL,
      timestamp(data.catalogObservedAt) + 86_400_000,
      ...['rolling', 'weekly', 'monthly'].map(window => timestamp(data.usage?.[window]?.resetsAt)));
  }
  if (!(expiresAt > now)) throw new Error('Dispatch evidence expires before admission.');
  const id = newTicketId();
  const native = { name: id, description: task.id, cwd, provider, model, ...(reasoning_effort !== undefined && { reasoning_effort }) };
  store.issue({ id, issuedAt: now, expiresAt, binding: { profile: host.profile, dshHome: directory(home), session: host.session, project, callerCwd, policy },
    request: native, selected, ...(pool && { pool, meterAt }), task: { id: task.id, data: task.data, effects: task.effects, role: task.role },
    ...(task.role === 'review' && { review: { implementers: task.implementers.map(({ canonicalModel }) => ({ canonicalModel })), reviewer: { canonicalModel } } }) });
  return { status: 'permit-issued', attempt: id, expiresAt: new Date(expiresAt).toISOString(), native, selected };
}

export function createDispatchGate({ home, store, getState, getCwd, observer, clock = Date.now }) {
  const asked = new WeakSet(), admitted = new WeakSet(), invoked = new WeakMap();
  function check(exec, row, now) {
    const policy = boundRoutingPolicy(getState(), home, row.binding.profile);
    const { request, binding } = row, agent = exec.agent;
    if (!policy || JSON.stringify(policy) !== JSON.stringify(binding.policy) || directory(home) !== binding.dshHome
        || !routeId(row.selected?.account) || row.selected.provider !== request.provider || row.selected.model !== request.model
        || row.selected.billing !== (row.selected.upstream === 'opencode-go' ? 'go-included' : 'subscription')
        || exec.signal?.aborted !== false || exec.parent !== undefined || typeof exec.token !== 'symbol'
        || agent?.id !== binding.session || agent.session?.id !== binding.session
        || directory(agent.session.header?.cwd) !== binding.project || directory(getCwd(agent.session)) !== binding.callerCwd
        || now < row.issuedAt || now >= row.expiresAt || row.expiresAt - row.issuedAt > TTL
        || directory(exec.arguments.cwd) !== request.cwd || exec.arguments.cwd !== request.cwd
        || Object.keys(exec.arguments).length !== Object.keys(request).length + 1 || !Object.hasOwn(exec.arguments, 'prompt')
        || Object.entries(request).some(([key, val]) => exec.arguments[key] !== val)
        || (row.selected?.upstream === 'opencode-go' && store.poolStatus(row.pool, now, row.meterAt ?? null) !== 'clear')) throw new Error(unsupported);
    const live = observer.export(exec)?.routes.find(route => route.provider === request.provider && route.model === request.model);
    if (!live || (request.reasoning_effort !== undefined && !live.reasoningEfforts.includes(request.reasoning_effort))) throw new Error(unsupported);
  }

  return {
    async preExecute(exec, next) {
      if (exec.name !== 'subagent') return next();
      try {
        const row = store.peek(exec.arguments?.name);
        if (row.status !== 'pending') return deny();
        check(exec, row, clock());
      } catch { return deny(); }
      const native = await next();
      if (!['allow', 'ask'].includes(native.kind)) return native;
      asked.add(exec);
      return native.kind === 'ask' ? native : { kind: 'ask', reason: 'Review the exact pending subagent task and data, then approve once only if they match the Kitto permit.' };
    },
    guard(exec) {
      if (exec.name !== 'subagent') return;
      if (!asked.delete(exec) || exec.signal?.aborted !== false) return deny();
      try {
        const now = clock();
        store.consume(exec.arguments.name, row => check(exec, row, now), now);
        admitted.add(exec);
      } catch { return deny(); }
    },
    async dispatch(exec, next) {
      if (exec.name !== 'subagent') return next();
      if (!admitted.delete(exec) || exec.signal?.aborted !== false) throw new Error(unsupported);
      const row = store.peek(exec.arguments.name);
      if (row.status !== 'consumed') throw new Error(unsupported);
      check(exec, row, clock());
      invoked.set(exec, row.id);
      return next();
    },
    result(exec, result) {
      const id = invoked.get(exec);
      invoked.delete(exec);
      if (id && result?.isError === false && result.value?.kind === 'activation' && result.value.name === id) {
        store.activate(id, clock());
      }
    },
  };
}

export function registerDshRouting(ctx) {
  ctx.inject(['profileContext', 'tools', 'workingDirectory'], host => {
    const { name, home, installAnchor } = host.profileContext;
    if (name !== 'web' || !isAbsolute(installAnchor ?? '') || !isAbsolute(home ?? '')) return;
    try {
      const manifest = createRequire(installAnchor)('./package.json');
      if (manifest.name !== '@deepseek-ai/dsh' || manifest.version !== ROUTING_HOST_VERSION) return;
    } catch { return; }
    const local = kittoHome(), getState = () => JSON.parse(readFileSync(join(local, 'state.json'), 'utf8'));
    const observer = createRouteObserver({ profile: name, enabled: () => {
      try { return Boolean(boundRoutingPolicy(getState(), home, name)); } catch { return false; }
    } });
    const gate = createDispatchGate({ home, store: createRoutingStore(local), getState, observer, getCwd: session => host.workingDirectory.get(session) });
    host.on('tools/pre-execute', gate.preExecute, { prepend: true });
    host.tools.guard(gate.guard);
    host.on('tools/execute', gate.dispatch);
    host.on('tools/result', observer.observe);
    host.on('tools/result', gate.result);
  });
}
