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
import type {
  DshPluginContext,
  DshPluginHost,
  DshToolDecision,
  DshToolExecution,
  DshToolResult,
  HostEvidence,
  RoutingBoundary,
  State,
} from '../types/kitto.d.ts';
import type { RouteTask, RoutingRequest } from '../lib/model-routing.ts';
import type { ValidDispatchPermit } from '../lib/routing-state.ts';

export const ROUTING_HOST_VERSION = routingHostVersion;
const TTL = 120_000;
const OBSERVATION_TTL = 300_000;
const unsupported = 'Kitto requires a fresh operator permit and native one-time approval for this subagent call.';
const deny = (): DshToolDecision => ({ kind: 'deny', reason: unsupported, info: { code: 'KITTO_ROUTE_DENIED' } });

type RoutingStore = ReturnType<typeof createRoutingStore>;

interface DispatchTask extends RouteTask {
  id?: string;
}

interface DispatchHost extends HostEvidence {
  version?: string;
  spawnVerified?: boolean;
}

interface DispatchRequest extends Omit<RoutingRequest, 'host' | 'task'> {
  host?: DispatchHost;
  task?: DispatchTask;
  dispatch?: { source?: string; project?: string; callerCwd?: string; cwd?: string };
  failure?: unknown;
  attempted?: unknown;
}

interface SelectedPermitRoute {
  provider: string;
  model: string;
  canonicalModel?: string;
  upstream?: string;
  account?: string;
  billing?: string;
}

interface IssuedPermit {
  status: 'permit-issued';
  attempt: string;
  expiresAt: string;
  native: Record<string, unknown>;
  selected: SelectedPermitRoute;
}

function activationId(result: DshToolResult | null | undefined): string | undefined {
  if (result?.isError !== false) return undefined;
  const value = result.value;
  if (typeof value !== 'object' || value === null) return undefined;
  const { kind, name } = value as { kind?: unknown; name?: unknown };
  return kind === 'activation' && typeof name === 'string' ? name : undefined;
}

function directory(path: unknown): string {
  if (typeof path !== 'string' || !isAbsolute(path) || !statSync(path).isDirectory()) throw new Error('Invalid routing directory.');
  return realpathSync(path);
}

export function boundRoutingPolicy(state: State | null | undefined, home: unknown, profile: unknown = 'web'): RoutingBoundary | null {
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
  request: DispatchRequest;
  store: RoutingStore;
  now?: number;
}): IssuedPermit {
  const { host, task, dispatch, go } = request ?? {};
  const policy = boundRoutingPolicy(state, home, host?.profile),
    budget = task?.budget;
  if (
    !policy ||
    host?.surface !== 'subagent' ||
    host.version !== ROUTING_HOST_VERSION ||
    host.spawnVerified !== true ||
    !Array.isArray(host.effectiveFallbacks) ||
    host.effectiveFallbacks.length !== 0 ||
    dispatch?.source !== 'operator-verified' ||
    !host ||
    !dispatch ||
    !task ||
    !routeId(host.session) ||
    !routeId(task.id) ||
    budget?.maxAdditionalCashUsd !== 0 ||
    !Number.isFinite(budget?.maxMonthlyGoFraction) ||
    (budget?.maxMonthlyGoFraction ?? 0) < 0 ||
    (budget?.maxMonthlyGoFraction ?? 0) > 1 ||
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
  const route = (host.routes ?? []).find((row) => row.provider === provider && row.model === model);
  if (!route) throw new Error('Dispatch route is no longer in the verified host capabilities.');
  const selected = { provider, model, canonicalModel, upstream: route.upstream, account: route.account, billing: route.billing };
  let pool: string | undefined,
    meterAt: string | undefined,
    expiresAt = Math.min(now + TTL, timestamp(host.observedAt) + OBSERVATION_TTL);
  if (route.upstream === 'opencode-go') {
    pool = go?.pool;
    const data = go?.metadata ?? go;
    meterAt = data?.observedAt;
    expiresAt = Math.min(
      expiresAt,
      timestamp(data?.observedAt) + OBSERVATION_TTL,
      timestamp(data?.catalogObservedAt) + 86_400_000,
      ...['rolling', 'weekly', 'monthly'].map((window) => timestamp(data?.usage?.[window]?.resetsAt)),
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
      review: {
        implementers: (task.implementers ?? []).map(({ canonicalModel: implementer }) => ({ canonicalModel: implementer })),
        reviewer: { canonicalModel },
      },
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
  store: RoutingStore;
  getState: () => State;
  getCwd: (session: unknown) => unknown;
  observer: ReturnType<typeof createRouteObserver>;
  clock?: () => number;
}) {
  const asked = new WeakSet<DshToolExecution>(),
    admitted = new WeakSet<DshToolExecution>(),
    invoked = new WeakMap<DshToolExecution, string>();
  function check(exec: DshToolExecution, row: ValidDispatchPermit, now: number) {
    const policy = boundRoutingPolicy(getState(), home, (row.binding ?? {}).profile),
      request = row.request ?? {},
      selected = row.selected,
      args = exec.arguments,
      agent = exec.agent,
      binding = row.binding ?? {};
    const effort = request.reasoning_effort;
    if (
      !policy ||
      !selected ||
      JSON.stringify(policy) !== JSON.stringify(binding.policy) ||
      directory(home) !== binding.dshHome ||
      !routeId(selected.account) ||
      selected.provider !== request.provider ||
      selected.model !== request.model ||
      selected.billing !== (selected.upstream === 'opencode-go' ? 'go-included' : 'subscription') ||
      exec.signal?.aborted !== false ||
      exec.parent !== undefined ||
      typeof exec.token !== 'symbol' ||
      agent?.id !== binding.session ||
      agent?.session?.id !== binding.session ||
      directory(agent?.session?.header?.cwd) !== binding.project ||
      directory(getCwd(agent?.session)) !== binding.callerCwd ||
      now < row.issuedAt ||
      now >= row.expiresAt ||
      row.expiresAt - row.issuedAt > TTL ||
      !args ||
      directory(args.cwd) !== request.cwd ||
      args.cwd !== request.cwd ||
      Object.keys(args).length !== Object.keys(request).length + 1 ||
      !Object.hasOwn(args, 'prompt') ||
      Object.entries(request).some(([key, val]: [string, unknown]) => args[key] !== val) ||
      (selected.upstream === 'opencode-go' && store.poolStatus(row.pool ?? '', now, row.meterAt ?? null) !== 'clear')
    )
      throw new Error(unsupported);
    const live = observer.export(exec)?.routes.find((route) => route.provider === request.provider && route.model === request.model);
    if (!live || (effort !== undefined && (typeof effort !== 'string' || !live.reasoningEfforts.includes(effort))))
      throw new Error(unsupported);
  }

  return {
    async preExecute(exec: DshToolExecution, next: () => Promise<DshToolDecision>): Promise<DshToolDecision> {
      if (exec.name !== 'subagent') return next();
      try {
        const row = store.peek(exec.arguments?.name ?? '');
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
    guard(exec: DshToolExecution): DshToolDecision | undefined {
      if (exec.name !== 'subagent') return;
      if (!asked.delete(exec) || exec.signal?.aborted !== false) return deny();
      try {
        const now = clock();
        store.consume(exec.arguments?.name ?? '', (row: ValidDispatchPermit) => check(exec, row, now), now);
        admitted.add(exec);
      } catch {
        return deny();
      }
    },
    async dispatch(exec: DshToolExecution, next: () => unknown) {
      if (exec.name !== 'subagent') return next();
      if (!admitted.delete(exec) || exec.signal?.aborted !== false) throw new Error(unsupported);
      const row = store.peek(exec.arguments?.name ?? '');
      if (row.status !== 'consumed') throw new Error(unsupported);
      check(exec, row, clock());
      invoked.set(exec, row.id ?? '');
      return next();
    },
    result(exec: DshToolExecution, result: DshToolResult) {
      const id = invoked.get(exec);
      invoked.delete(exec);
      if (id && activationId(result) === id) store.activate(id, clock());
    },
  };
}

export function registerDshRouting(ctx: DshPluginContext): void {
  ctx.inject(['profileContext', 'tools', 'workingDirectory'], (injected) => {
    const host = injected as DshPluginHost;
    const { name, home, installAnchor } = host.profileContext;
    if (name !== 'web' || !installAnchor || !isAbsolute(installAnchor) || !home || !isAbsolute(home)) return;
    try {
      const manifest = createRequire(installAnchor)('./package.json');
      if (manifest.name !== '@deepseek-ai/dsh' || manifest.version !== ROUTING_HOST_VERSION) return;
    } catch {
      return;
    }
    const local = kittoHome(),
      getState = () => JSON.parse(readFileSync(join(local, 'state.json'), 'utf8')) as State;
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
      getCwd: (session) => host.workingDirectory.get(session),
    });
    host.on('tools/pre-execute', gate.preExecute, { prepend: true });
    host.tools.guard(gate.guard);
    host.on('tools/execute', gate.dispatch);
    host.on('tools/result', observer.observe);
    host.on('tools/result', gate.result);
  });
}
