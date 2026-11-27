import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'vitest';
import type { TestContext } from 'vitest';
import { createDispatchGate, issueRoutePermit, registerDshRouting, ROUTING_HOST_VERSION } from '../integration/dsh-routing.ts';
import { createRouteObserver } from '../integration/dsh-route-evidence.ts';
import { setRoutingBoundary } from '../lib/routing-policy.ts';
import { createRoutingStore } from '../lib/routing-state.ts';
import type { DshToolDecision, State } from '../types/kitto.d.ts';

type Json = Record<string, any>;

const route = {
  provider: 'openai-codex',
  model: 'gpt-6.2-sol',
  canonicalModel: 'openai/gpt-6.2-sol',
  upstream: 'openai-codex',
  account: 'fixture-account',
  accountType: 'personal',
  accountVerified: true,
  billing: 'subscription',
  available: true,
  reasoningEfforts: ['low'],
};
function fixture(t: TestContext, boundary = 'personal') {
  const root = mkdtempSync(join(tmpdir(), 'kitto-dsh-route-'));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'native'),
    project = join(root, 'project');
  mkdirSync(home);
  mkdirSync(project);
  let now = Date.now();
  const clock = () => now,
    store = createRoutingStore(root);
  const state: State = {
    schema: 1,
    source: 'test',
    routingInstallKind: 'local',
    ready: true,
    agents: ['dsh'],
    dshProfile: 'web',
    dshHome: home,
  };
  setRoutingBoundary(state, boundary);
  const request: Json = {
    host: {
      kind: 'dsh',
      installation: 'full-local',
      profile: 'web',
      surface: 'subagent',
      session: 'test-session',
      version: ROUTING_HOST_VERSION,
      observedAt: new Date(now).toISOString(),
      effectiveFallbacks: [],
      spawnVerified: true,
      routes: [route],
    },
    task: {
      id: 'verify-fixture',
      role: 'verify',
      effects: 'read',
      data: 'public',
      effort: ['low'],
      budget: { maxAdditionalCashUsd: 0, maxMonthlyGoFraction: 0 },
      authorized: [{ ...route, data: 'public' }],
    },
    dispatch: { source: 'operator-verified', project, cwd: project, callerCwd: project },
  };
  const agent: Json = { id: 'test-session', session: { id: 'test-session', header: { cwd: project } } };
  const signal = new AbortController().signal;
  const observer = createRouteObserver({ profile: 'web', enabled: () => true, clock });
  const gate = createDispatchGate({ home, store, getState: () => state, getCwd: () => project, observer, clock });
  const observe = (item = route) =>
    observer.observe(
      { name: 'list_subagent_models', arguments: { provider: item.provider, model: item.model }, agent, token: Symbol(), signal },
      { isError: false, value: `${item.provider}/${item.model} — Fixture\nReasoning efforts:\nlow — Low` },
    );
  const issue = () => issueRoutePermit({ state, home, request, store, now });
  const exec = (permit: Json, args: Json = {}) => {
    const native = { ...permit.native, ...args };
    Object.defineProperty(native, 'prompt', {
      enumerable: true,
      get() {
        throw new Error('Kitto must not read the prompt');
      },
    });
    return { name: 'subagent', agent, token: Symbol(), signal, arguments: native };
  };
  return {
    root,
    home,
    project,
    request,
    gate,
    store,
    issue,
    exec,
    observe,
    state,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
const allow = async () => ({ kind: 'allow' }) as DshToolDecision;
function guarded(gate: ReturnType<typeof fixture>['gate'], exec: Json) {
  const decision = gate.guard(exec);
  assert.ok(decision);
  return decision;
}

test('live evidence and host ask precede the one-shot native dispatch', async (t) => {
  const f = fixture(t);
  const permit = f.issue(),
    first = f.exec(permit),
    second = f.exec(permit);
  assert.equal((await f.gate.preExecute(first, allow)).kind, 'deny');
  f.observe();
  assert.equal((await f.gate.preExecute(f.exec(permit, { reasoning_effort: 'high' }), allow)).kind, 'deny');
  assert.equal((await f.gate.preExecute({ ...first, parent: Symbol() }, allow)).kind, 'deny');
  assert.equal((await f.gate.preExecute({ ...first, agent: { id: 'other', session: first.agent.session } }, allow)).kind, 'deny');
  assert.equal((await f.gate.preExecute(first, async () => ({ kind: 'deny', reason: 'native veto' }))).reason, 'native veto');
  assert.equal(guarded(f.gate, first).kind, 'deny');
  const decisions = await Promise.all([f.gate.preExecute(first, allow), f.gate.preExecute(second, allow)]);
  assert.deepEqual(
    decisions.map((item) => item.kind),
    ['ask', 'ask'],
  );
  assert.equal(f.gate.guard(first), undefined);
  assert.equal(guarded(f.gate, second).kind, 'deny');
  let called = 0;
  await f.gate.dispatch(first, async () => {
    called++;
  });
  await assert.rejects(
    f.gate.dispatch(first, async () => {
      called++;
    }),
    /fresh operator permit/,
  );
  assert.equal(called, 1);
  f.gate.result(first, { isError: false, value: { kind: 'activation', name: permit.attempt } });
  assert.equal(f.store.peek(permit.attempt).status, 'activated');
  assert.equal((await f.gate.preExecute(f.exec(permit), allow)).kind, 'deny');
  assert.equal(guarded(f.gate, f.exec(permit)).kind, 'deny');
});

test('expired and interrupted attempts stay spent; failed dispatch never authorizes a retry', async (t) => {
  const f = fixture(t);
  f.observe();
  const permit = f.issue(),
    exec = f.exec(permit);
  assert.equal((await f.gate.preExecute(exec, allow)).kind, 'ask');
  f.gate.guard(exec);
  await assert.rejects(
    f.gate.dispatch(exec, async () => {
      throw new Error('interrupted');
    }),
    /interrupted/,
  );
  f.gate.result(exec, { isError: true });
  assert.equal(f.store.peek(permit.attempt).status, 'consumed');
  assert.equal(guarded(f.gate, exec).kind, 'deny');
  const second = f.exec(f.issue());
  assert.equal((await f.gate.preExecute(second, allow)).kind, 'ask');
  f.advance(120_000);
  assert.equal(guarded(f.gate, second).kind, 'deny');
});

test('only explicitly verified native spawn and approved account/data/budget qualify', (t) => {
  const f = fixture(t, 'company');
  assert.throws(f.issue, /preflight stopped/);
  const company = { ...route, accountType: 'company' };
  f.request.host.routes = [company];
  f.request.task.authorized = [{ ...company, data: 'public' }];
  assert.equal(f.issue().status, 'permit-issued');
  f.request.host.effectiveFallbacks = [{ model: 'inherited' }];
  assert.throws(f.issue, /Unverified dispatch/);
  f.request.host.effectiveFallbacks = [];
  f.request.host.surface = 'teams';
  assert.throws(f.issue, /Unverified dispatch/);
  f.request.host.surface = 'subagent';
  f.request.task.budget.maxAdditionalCashUsd = 1;
  assert.throws(f.issue, /Unverified dispatch/);
});

test(
  'pinned Cordis pipeline dispatches a permitted registered tool once and retains native veto',
  { skip: !process.env.KITTO_TEST_DSH_INSTALL },
  async (t) => {
    const installDir = process.env.KITTO_TEST_DSH_INSTALL;
    assert.ok(installDir);
    const installAnchor = join(installDir, 'package.json');
    const require = createRequire(installAnchor);
    assert.equal(require('./package.json').version, ROUTING_HOST_VERSION);
    const { Context } = require('@deepseek-ai/cordis');
    const { ToolsService } = require('@deepseek-ai/dsh-tools');
    const native = require('@deepseek-ai/dsh-tool-subagent');
    const { ToolExecutionPipeline } = require(join(dirname(require.resolve('@deepseek-ai/dsh-tools')), 'pipeline.js'));
    const f = fixture(t);
    const prior = process.env.KITTO_HOME;
    process.env.KITTO_HOME = f.root;
    t.onTestFinished(() => {
      if (prior === undefined) delete process.env.KITTO_HOME;
      else process.env.KITTO_HOME = prior;
    });
    writeFileSync(join(f.root, 'state.json'), JSON.stringify(f.state));
    const ctx = new Context();
    ctx.provide('systemPrompt', { tools() {}, section() {}, context() {}, getSectionOrder: () => 0, getContextOrder: () => 0 });
    ctx.provide('profileContext', { name: 'web', home: f.home, installAnchor });
    ctx.provide('workingDirectory', { get: () => f.project });
    const spawn = { name: 'spawn', inheritsParentContext: false, capabilities: { agentOptions: true } };
    const starts: Json[] = [],
      preflights: Json[] = [];
    let allowed = [{ provider: route.provider, model: route.model }],
      approved = false,
      asks = 0;
    ctx.provide('sessionProjections', { register: async () => ({ stateOf: () => allowed }) });
    ctx.provide('subagents', {
      getProvider: (name: string) => (name === 'spawn' ? spawn : undefined),
      resolveMaxDepth: () => undefined,
      startActivation: async (input: Json) => {
        starts.push(input);
        return { name: input.name };
      },
    });
    ctx.provide('llm', {
      listProviders: () => [{ id: route.provider, name: 'Offline provider' }],
      resolveModelInfo: async () => ({ id: route.model, name: 'Offline model', reasoning: { efforts: [{ id: 'low', name: 'Low' }] } }),
      resolveCallConfig: async (options: Json) => {
        preflights.push(options);
      },
    });
    ctx.provide('approval', {
      request: async () => {
        asks++;
        return approved ? 'allowed-once' : 'rejected';
      },
    });
    await ctx.plugin(ToolsService);
    await ctx.plugin(registerDshRouting);
    await ctx.plugin(native, { provider: 'spawn', modelSelection: true, modelDiscovery: true, maxDepth: 'provider-managed' });
    const pipeline = new ToolExecutionPipeline(ctx),
      permit = f.issue(),
      { agent, signal } = f.exec(permit);
    agent.session.requestHeader = () => undefined;
    agent.options = { provider: route.provider, model: route.model };
    async function run(name: string, args: Json) {
      const stage = await pipeline.prepare({ callId: 'fixture-call', name, arguments: args, agent, signal });
      return pipeline.complete(stage.exec, stage.kind === 'dispatch' ? await pipeline.dispatch(stage.exec) : stage);
    }
    const args = { ...permit.native, prompt: 'Offline fixture; no model request' };
    assert.equal((await run('subagent', args)).isError, true);
    assert.equal((await run('list_subagent_models', { provider: route.provider, model: route.model })).isError, false);
    assert.equal((await run('subagent', args)).isError, true);
    assert.equal(starts.length, 0);
    approved = true;
    assert.equal((await run('subagent', args)).isError, false);
    assert.equal((await run('subagent', args)).isError, true);
    assert.equal(starts.length, 1);
    const expected = { provider: route.provider, model: route.model, reasoningEffort: 'low' };
    assert.deepEqual(starts[0].agentOptions, expected);
    assert.deepEqual(preflights, [expected]);
    assert.equal(asks, 2);
    assert.equal(f.store.peek(permit.attempt).status, 'activated');
    const vetoed = f.issue();
    allowed = [];
    assert.equal((await run('subagent', { ...vetoed.native, prompt: 'Offline native allowlist veto' })).isError, true);
    assert.equal(starts.length, 1);
    assert.equal(f.store.peek(vetoed.attempt).status, 'consumed');
  },
);

test('a verified shared Go hold rejects issued permits and aliases without blocking a non-Go route', async (t) => {
  const f = fixture(t);
  const flash = {
    ...route,
    provider: 'opencode-go',
    model: 'deepseek-v4.1-flash',
    canonicalModel: 'deepseek/deepseek-v4.1-flash-1017',
    upstream: 'opencode-go',
    billing: 'go-included',
    pool: 'paid-go-pool',
  };
  const now = Date.parse(f.request.host.observedAt),
    stamp = f.request.host.observedAt;
  const setRoute = (item: Json) => {
    f.request.host.routes = [item];
    f.request.task.authorized = [{ ...item, data: 'public' }];
  };
  setRoute(flash);
  f.request.task.tokens = { input: 10_000, output: 500 };
  f.request.go = {
    account: flash.account,
    pool: flash.pool,
    plan: 'go',
    extraUsage: 'off',
    observedAt: stamp,
    catalogObservedAt: stamp,
    usage: Object.fromEntries(
      ['rolling', 'weekly', 'monthly'].map((window) => [
        window,
        { status: 'ok', percent: 10, resetsAt: new Date(now + 3600_000).toISOString() },
      ]),
    ),
    catalog: {
      data: [
        {
          id: flash.model,
          canonical_id: flash.canonicalModel,
          type: 'chat',
          go: { training: false, monthly_usage: { go: 10 } },
          cost: { text: { input: { price: 0.15 }, output: { price: 0.5 } } },
        },
      ],
    },
  };
  assert.throws(f.issue, /preflight stopped/);
  f.request.task.budget.maxMonthlyGoFraction = 0.01;
  const activated = f.issue(),
    pending = f.issue();
  f.observe(flash);
  const exec = f.exec(activated);
  assert.equal((await f.gate.preExecute(exec, allow)).kind, 'ask');
  f.gate.guard(exec);
  await f.gate.dispatch(exec, async () => {});
  f.gate.result(exec, { isError: false, value: { kind: 'activation', name: activated.attempt } });
  f.store.recordQuota(
    {
      attempt: activated.attempt,
      route: flash,
      pool: flash.pool,
      code: 'QUOTA',
      observedAt: stamp,
      source: 'operator-verified-native-failure',
      quotaScope: 'paid-go-pool',
    },
    now,
  );
  assert.equal((await f.gate.preExecute(f.exec(pending), allow)).kind, 'deny');
  setRoute({ ...flash, provider: 'alternate-provider' });
  assert.throws(f.issue, /preflight stopped/);
  setRoute({ ...flash, pool: 'unrelated-pool', account: 'unrelated-account' });
  f.request.go.pool = 'unrelated-pool';
  f.request.go.account = 'unrelated-account';
  assert.equal(f.issue().status, 'permit-issued');
  setRoute(route);
  assert.equal(f.issue().selected.provider, route.provider);
});
