import { readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, sep } from 'node:path';
import { createRouteObserver } from './dsh-route-evidence.ts';
import { timestamp } from '../lib/go-allowance.ts';
import { routingHostVersion } from '../lib/host-pins.ts';
import { kittoHome } from '../lib/kitto-home.ts';
import { adviseRoute } from '../lib/model-routing.ts';
import { activeRoutingBoundary, routeId } from '../lib/routing-policy.ts';
import { createRoutingStore, newTicketId } from '../lib/routing-state.ts';
import type { Json, State, DshPluginContext } from '../types/kitto.d.ts';

export const ROUTING_HOST_VERSION = routingHostVersion;
const TTL = 120_000;
const OBSERVATION_TTL = 300_000;
const unsupported = 'Kitto requires a fresh operator permit and native one-time approval for this subagent call.';
const deny = () => ({ kind: 'deny', reason: unsupported, info: { code: 'KITTO_ROUTE_DENIED' } });

function directory(path: unknown): string {
  if (typeof path !== 'string' || !isAbsolute(path) || !statSync(path).isDirectory()) throw new Error('Invalid routing directory.');
  return realpathSync(path);
}

export function boundRoutingPolicy(state: State | null | undefined, home: unknown, profile: string = 'web'): Json | null {
  try {
    return (profile === 'web' && directory(state?.dshHome) === directory(home) && activeRoutingBoundary(state, profile)) || null;
  } catch {
    return null;
  }
}

export function issueRoutePermit({
  state,
  home,
  request,
  store,
  now = Date.now(),
}: {
  state: State;
  home: string;
  request: Json;
  store: Json;
  now?: number;
}): Json {
  const { host, task, dispatch, go } = request ?? {};
  const policy = boundRoutingPolicy(state, home, host?.profile);
  if (
    !policy ||
    host?.surface !== 'subagent' ||
    host.version !== ROUTING_HOST_VERSION ||
    host.spawnVerified !== true ||
    !Array.isArray(host.effectiveFallbacks) ||
    host.effectiveFallbacks.length !== 0 ||
    dispatch?.source !== 'operator-verified' ||
    !routeId(host.session) ||
    !routeId(task?.id) ||
    task.budget?.maxAdditionalCashUsd !== 0 ||
    !Number.isFinite(task.budget.maxMonthlyGoFraction) ||
    task.budget.maxMonthlyGoFraction < 0 ||
    task.budget.maxMonthlyGoFraction > 1 ||
    request.failure !== undefined ||
    request.attempted !== undefined
  )
    throw new Error('Unverified dispatch authorization, budget or host.');
  const project = directory(dispatch.project),
    callerCwd = directory(dispatch.callerCwd),
    cwd = directory(dispatch.cwd);
  for (const path of [callerCwd, cwd]) {
    const fromProject = relative(project, path);
    if (isAbsolute(fromProject) || fromProject === '..' || fromProject.startsWith(`..${sep}`))
      throw new Error('Dispatch cannot leave the approved project.');
  }
  const result = adviseRoute({
    state,
    request,
    now,
    poolStatus: (pool, meterAt) => store.poolStatus(pool, now, meterAt),
    controlled: true,
  });
  if (result.status !== 'recommend') throw new Error(`Dispatch preflight stopped: ${result.reason}.`);
  const { provider, model, reasoning_effort, canonicalModel } = result.route;
  const route = host.routes.find((row: Json) => row.provider === provider && row.model === model);
  const selected = { provider, model, canonicalModel, upstream: route.upstream, account: route.account, billing: route.billing };
  let pool: string | undefined,
    meterAt: string | undefined,
    expiresAt = Math.min(now + TTL, timestamp(host.observedAt) + OBSERVATION_TTL);
  if (route.upstream === 'opencode-go') {
    pool = go.pool;
    const data = go.metadata ?? go;
    meterAt = data.observedAt;
    expiresAt = Math.min(
      expiresAt,
      timestamp(data.observedAt) + OBSERVATION_TTL,
      timestamp(data.catalogObservedAt) + 86_400_000,
      ...['rolling', 'weekly', 'monthly'].map((window) => timestamp(data.usage?.[window]?.resetsAt)),
    );
  }
  if (!(expiresAt > now)) throw new Error('Dispatch evidence expires before admission.');
  const id = newTicketId();
  const native = { name: id, description: task.id, cwd, provider, model, ...(reasoning_effort !== undefined && { reasoning_effort }) };
  store.issue({
    id,
    issuedAt: now,
    expiresAt,
    binding: { profile: host.profile, dshHome: directory(home), session: host.session, project, callerCwd, policy },
    request: native,
    selected,
    ...(pool && { pool, meterAt }),
    task: { id: task.id, data: task.data, effects: task.effects, role: task.role },
    ...(task.role === 'review' && {
      review: { implementers: task.implementers.map(({ canonicalModel }: Json) => ({ canonicalModel })), reviewer: { canonicalModel } },
    }),
  });
  return { status: 'permit-issued', attempt: id, expiresAt: new Date(expiresAt).toISOString(), native, selected };
}

export function createDispatchGate({
  home,
  store,
  getState,
  getCwd,
  observer,
  clock = Date.now,
}: {
  home: string;
  store: Json;
  getState: () => State;
  getCwd: (session: Json) => unknown;
  observer: Json;
  clock?: () => number;
}) {
  const asked = new WeakSet<object>(),
    admitted = new WeakSet<object>(),
    invoked = new WeakMap<object, string>();
  function check(exec: Json, row: Json, now: number) {
    const policy = boundRoutingPolicy(getState(), home, row.binding.profile);
    const { request, binding } = row,
      agent = exec.agent;
    if (
      !policy ||
      JSON.stringify(policy) !== JSON.stringify(binding.policy) ||
      directory(home) !== binding.dshHome ||
      !routeId(row.selected?.account) ||
      row.selected.provider !== request.provider ||
      row.selected.model !== request.model ||
      row.selected.billing !== (row.selected.upstream === 'opencode-go' ? 'go-included' : 'subscription') ||
      exec.signal?.aborted !== false ||
      exec.parent !== undefined ||
      typeof exec.token !== 'symbol' ||
      agent?.id !== binding.session ||
      agent.session?.id !== binding.session ||
      directory(agent.session.header?.cwd) !== binding.project ||
      directory(getCwd(agent.session)) !== binding.callerCwd ||
      now < row.issuedAt ||
      now >= row.expiresAt ||
      row.expiresAt - row.issuedAt > TTL ||
      directory(exec.arguments.cwd) !== request.cwd ||
      exec.arguments.cwd !== request.cwd ||
      Object.keys(exec.arguments).length !== Object.keys(request).length + 1 ||
      !Object.hasOwn(exec.arguments, 'prompt') ||
      Object.entries(request).some(([key, val]: [string, unknown]) => exec.arguments[key] !== val) ||
      (row.selected?.upstream === 'opencode-go' && store.poolStatus(row.pool, now, row.meterAt ?? null) !== 'clear')
    )
      throw new Error(unsupported);
    const live = observer.export(exec)?.routes.find((route: Json) => route.provider === request.provider && route.model === request.model);
    if (!live || (request.reasoning_effort !== undefined && !live.reasoningEfforts.includes(request.reasoning_effort)))
      throw new Error(unsupported);
  }

  return {
    async preExecute(exec: Json, next: () => Promise<Json>) {
      if (exec.name !== 'subagent') return next();
      try {
        const row = store.peek(exec.arguments?.name);
        if (row.status !== 'pending') return deny();
        check(exec, row, clock());
      } catch {
        return deny();
      }
      const native = await next();
      if (!['allow', 'ask'].includes(native.kind)) return native;
      asked.add(exec);
      return native.kind === 'ask'
        ? native
        : {
            kind: 'ask',
            reason: 'Review the exact pending subagent task and data, then approve once only if they match the Kitto permit.',
          };
    },
    guard(exec: Json) {
      if (exec.name !== 'subagent') return;
      if (!asked.delete(exec) || exec.signal?.aborted !== false) return deny();
      try {
        const now = clock();
        store.consume(exec.arguments.name, (row: Json) => check(exec, row, now), now);
        admitted.add(exec);
      } catch {
        return deny();
      }
    },
    async dispatch(exec: Json, next: () => unknown) {
      if (exec.name !== 'subagent') return next();
      if (!admitted.delete(exec) || exec.signal?.aborted !== false) throw new Error(unsupported);
      const row = store.peek(exec.arguments.name);
      if (row.status !== 'consumed') throw new Error(unsupported);
      check(exec, row, clock());
      invoked.set(exec, row.id);
      return next();
    },
    result(exec: Json, result: Json) {
      const id = invoked.get(exec);
      invoked.delete(exec);
      if (id && result?.isError === false && result.value?.kind === 'activation' && result.value.name === id) {
        store.activate(id, clock());
      }
    },
  };
}

export function registerDshRouting(ctx: DshPluginContext): void {
  ctx.inject(['profileContext', 'tools', 'workingDirectory'], (host: Json) => {
    const { name, home, installAnchor } = host.profileContext;
    if (name !== 'web' || !isAbsolute(installAnchor ?? '') || !isAbsolute(home ?? '')) return;
    try {
      const manifest = createRequire(installAnchor)('./package.json');
      if (manifest.name !== '@deepseek-ai/dsh' || manifest.version !== ROUTING_HOST_VERSION) return;
    } catch {
      return;
    }
    const local = kittoHome(),
      getState = () => JSON.parse(readFileSync(join(local, 'state.json'), 'utf8'));
    const observer = createRouteObserver({
      profile: name,
      enabled: () => {
        try {
          return Boolean(boundRoutingPolicy(getState(), home, name));
        } catch {
          return false;
        }
      },
    });
    const gate = createDispatchGate({
      home,
      store: createRoutingStore(local),
      getState,
      observer,
      getCwd: (session: Json) => host.workingDirectory.get(session),
    });
    host.on('tools/pre-execute', gate.preExecute, { prepend: true });
    host.tools.guard(gate.guard);
    host.on('tools/execute', gate.dispatch);
    host.on('tools/result', observer.observe);
    host.on('tools/result', gate.result);
  });
}
