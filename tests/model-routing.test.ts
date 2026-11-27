import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { fileURLToPath } from 'node:url';
import { adviseRoute } from '../lib/model-routing.ts';
import { estimateGoFraction, goMeter, goModel, normalizeGoCharge } from '../lib/go-allowance.ts';
import { hosts } from '../lib/host-pins.ts';
import { setRoutingBoundary } from '../lib/routing-policy.ts';
import { parseOptions } from '../lib/kitto.ts';
import { issueRoutePermit, ROUTING_HOST_VERSION } from '../integration/dsh-routing.ts';
import { createRoutingStore } from '../lib/routing-state.ts';

const now = Date.parse('2026-11-25T12:00:00Z');
const stamp = new Date(now).toISOString();
const reset = new Date(now + 3600_000).toISOString();
const sol = {
  provider: 'openai-codex',
  model: 'gpt-6.2-sol',
  canonicalModel: 'openai/gpt-6.2-sol',
  upstream: 'openai-codex',
  billing: 'subscription',
  account: 'personal-codex',
  accountType: 'personal',
  accountVerified: true,
  available: true,
  reasoningEfforts: ['low', 'medium', 'high'],
};
const claude = {
  ...sol,
  upstream: 'anthropic',
  provider: 'company-claude',
  model: 'claude-stable',
  canonicalModel: 'anthropic/claude-sonnet-5-5',
  account: 'corp-claude',
  accountType: 'company',
  tier: 1,
  premium: false,
};
const router = { ...claude, upstream: 'openrouter', provider: 'corp-router', account: 'corp-router-plan' };
const makeGo = (model, canonicalModel, reasoningEfforts) => ({
  ...sol,
  provider: 'opencode-go',
  upstream: 'opencode-go',
  billing: 'go-included',
  account: 'my-go',
  model,
  canonicalModel,
  reasoningEfforts,
});
const flash = makeGo('deepseek-v4.1-flash', 'deepseek/deepseek-v4.1-flash-1017', ['low', 'high']);
const glmFlash = makeGo('glm-5.3-flash', 'zhipuai/glm-5.3-flash', ['low', 'medium']);
const glm = makeGo('glm-5.3', 'zhipuai/glm-5.3', ['low', 'medium']);
const grok = makeGo('grok-4.7', 'xai/grok-4.7', ['low', 'high']);
const goEntry = (route, monthly, plus, teams, input, output) => ({
  id: route.model,
  canonical_id: route.canonicalModel,
  type: 'chat',
  go: { monthly_usage: { go: monthly, 'go-plus': plus, 'go-teams': teams }, training: false },
  cost: { text: { input: { price: input }, output: { price: output } } },
});
const goFixture = () => ({
  plan: 'go',
  account: 'my-go',
  extraUsage: 'off',
  observedAt: stamp,
  catalogObservedAt: stamp,
  usage: Object.fromEntries(['rolling', 'weekly', 'monthly'].map((key) => [key, { status: 'ok', percent: 10, resetsAt: reset }])),
  catalog: {
    object: 'list',
    data: [
      goEntry(flash, 100, 200, 105, 0.15, 0.6),
      goEntry(glmFlash, 60, 180, 65, 0.15, 0.5),
      goEntry(glm, 200, 400, 205, 1.4, 4.4),
      goEntry(grok, 15, 60, 20, 2, 6),
    ],
  },
});

function state(mode = 'personal', custom) {
  const value = { schema: 1, routingInstallKind: 'local', ready: true, agents: ['dsh'], dshProfile: 'web', preserveMe: 42 };
  setRoutingBoundary(value, mode, custom);
  return value;
}
function fixture(routes = [flash, glmFlash], options = {}) {
  const { role = 'verify', data = 'public', surface = 'subagent', effects = 'read' } = options;
  return {
    host: {
      kind: 'dsh',
      installation: 'full-local',
      profile: 'web',
      surface,
      observedAt: stamp,
      routes,
      ...(surface === 'teams' && { effectiveFallbacks: [] }),
    },
    task: {
      role,
      data,
      effects,
      effort: ['low'],
      tokens: { input: 10_000, output: 1_000 },
      authorized: routes.map(({ provider, model, canonicalModel, upstream, billing, account, accountType }) => ({
        provider,
        model,
        canonicalModel,
        upstream,
        billing,
        account,
        accountType,
        data,
      })),
    },
    go: goFixture(),
  };
}
const advise = (request, saved = state()) => adviseRoute({ request, state: saved, now });
const reasons = (result) => result.rejected.map((row) => row.reason);

test('missing, skipped, damaged, copied and non-local device confirmations stop', () => {
  const request = fixture();
  for (const saved of [
    null,
    {},
    state('skip'),
    { ...state(), ready: false },
    { ...state(), routingInstallKind: 'service' },
    { ...state(), routingBoundary: { ...state().routingBoundary, identity: 'another-machine' } },
    { ...state(), routingBoundary: { ...state().routingBoundary, routes: [flash.model] } },
  ]) {
    assert.equal(advise(request, saved).reason, 'boundary-unconfirmed');
  }
  assert.equal(advise({ ...request, host: { ...request.host, installation: 'scoped' } }).reason, 'unsupported-surface');
  assert.equal(advise({ ...request, host: { ...request.host, profile: 'desktop' } }).reason, 'boundary-unconfirmed');
  assert.throws(() => parseOptions(['--routing-boundary', 'personal', '--routing-boundary', 'company']), /at most once/);
});

test('company separates personal from approved custom Claude or OpenRouter upstreams', () => {
  const saved = state('company');
  const request = fixture([sol, claude], { role: 'implement', data: 'internal' });
  const result = advise(request, saved);
  assert.equal(result.route.provider, claude.provider);
  assert.deepEqual(reasons(result), ['account-or-data-boundary']);
  assert.equal(saved.preserveMe, 42);
  assert.deepEqual(Object.keys(saved.routingBoundary).sort(), ['identity', 'mode', 'profile', 'schema']);
  assert.equal(advise(fixture([router], { role: 'implement', data: 'restricted' }), saved).route.provider, router.provider);
  for (const invalid of [
    { ...router, billing: 'payg' },
    { ...router, upstream: 'unknown' },
    { ...router, accountVerified: false },
  ]) {
    assert.equal(advise(fixture([invalid]), saved).status, 'stop');
  }
  request.task.authorized[1].account = 'different';
  assert.equal(advise(request, saved).status, 'stop');
  const custom = state('custom', `${router.provider}/${router.model}`);
  assert.equal(advise(fixture([router, claude], { role: 'implement' }), custom).route.provider, router.provider);
  assert.throws(() => setRoutingBoundary(saved, 'custom', 'invalid'), /custom routing boundary/);
});

test('Go ranks plan-normalized estimates and selects the tightest time window', () => {
  const request = fixture();
  assert.equal(advise(request).route.model, flash.model);
  request.go.plan = 'go-plus';
  assert.equal(advise(request).route.model, flash.model);
  request.go.plan = 'go-teams';
  assert.equal(advise(request).route.model, flash.model);
  request.go.plan = 'go';
  request.go.catalog.data[1].go.monthly_usage.go = 500;
  request.go.usage.weekly.percent = 98;
  const result = advise(request);
  assert.equal(result.route.model, glmFlash.model);
  assert.equal(result.go.limitingWindow, 'weekly');
  assert.equal(result.go.remaining, 0.005);
  assert.ok(result.estimatedMonthlyFraction > 0);
});

test('Go handles missing, expired, stale, malformed, exhausted and tiny headroom distinctly', () => {
  for (const [reason, edit] of Object.entries({
    missing: (request) => {
      delete request.go.usage;
    },
    stale: (request) => {
      request.go.observedAt = '2026-11-25T11:00:00Z';
    },
    invalid: (request) => {
      delete request.go.usage.monthly;
    },
    exhausted: (request) => {
      request.go.usage.rolling = { status: 'rate-limited', percent: 99, resetsAt: reset };
    },
  })) {
    const request = fixture();
    edit(request);
    const result = advise(request);
    assert.equal(result.status, 'stop');
    assert.ok(reasons(result).includes(`go-meter-${reason}`));
  }
  const request = fixture();
  request.go.usage.weekly.resetsAt = stamp;
  assert.equal(goMeter(request.go, now).status, 'stale');
  request.go.usage.weekly = { status: 'ok', percent: 99, resetsAt: reset };
  assert.ok(reasons(advise(request)).includes('go-insufficient-headroom'));
  request.go.usage.weekly.percent = 10;
  request.go.extraUsage = 'on';
  assert.ok(reasons(advise(request)).includes('go-account-or-overage-unverified'));
});

test('request allowance overrides list cost; official monthly caps and conservative tariffs are plan specific', () => {
  const go = goFixture();
  go.plan = 'go-teams';
  const model = goModel(go, flash.model, now);
  assert.equal(model.cap, 105);
  const usage = { cost: 0, opencode: { billing_source: 'go', allowance: 2.1, list_cost: 3.15 } };
  assert.deepEqual(normalizeGoCharge(usage, model, go.plan), { fraction: 0.02, source: 'allowance' });
  delete usage.opencode.allowance;
  assert.deepEqual(normalizeGoCharge(usage, model, go.plan), { fraction: 0.03, source: 'list-cost-estimate' });
  usage.opencode.billing_source = 'balance';
  assert.equal(normalizeGoCharge(usage, model, go.plan), null);
  model.item.cost.multipliers = [{ factor: 2 }];
  model.item.cost.text.input.overrides = [{ price: 0.3, cache: { write: { '5m': 0.5 } } }];
  assert.ok(Math.abs(estimateGoFraction(model, { input: 1e6, output: 1e6 }) - 2.2 / 105) < 1e-12);
});

test('unsupported efforts, unavailable routes, unknown models and unapproved premium do not silently pass', () => {
  const unknown = makeGo('imaginary-model', 'deepseek/imaginary-model', ['low']);
  const request = fixture([flash, { ...glmFlash, available: false }, unknown, grok]);
  request.task.effort = ['medium'];
  assert.deepEqual(reasons(advise(request)), [
    'effort-unavailable',
    'unavailable-or-not-allowed',
    'upstream-or-model-metadata-unverified',
    'premium-not-approved',
  ]);
  request.task.effort = ['default'];
  assert.ok(!Object.hasOwn(advise(request).route, 'reasoning_effort'));
  request.host.surface = 'teams';
  assert.equal(advise(request).reason, 'native-fallback-unverified-or-enabled');
  request.host.effectiveFallbacks = [{ provider: sol.provider, model: sol.model }];
  assert.equal(advise(request).reason, 'native-fallback-unverified-or-enabled');
  request.host.effectiveFallbacks = [];
  assert.equal(advise(request).route.reasoning_effort, 'default');
});

test('built-in short names cannot inherit a lower tier from a same-family catalog remap', () => {
  const disguised = { ...flash, canonicalModel: 'deepseek/deepseek-v4-pro' };
  const request = fixture([disguised]);
  request.go.catalog.data[0].canonical_id = disguised.canonicalModel;
  assert.deepEqual(reasons(advise(request)), ['upstream-or-model-metadata-unverified']);
  const external = { ...router, canonicalModel: disguised.canonicalModel, tier: 0 };
  assert.deepEqual(reasons(advise(fixture([external]))), ['premium-not-approved']);
});

test('native capability imports supply exact effort without changing authorization or pool holds', () => {
  const request = fixture([flash, glmFlash, sol]);
  request.host.session = 'fixture-session';
  request.host.evidence = {
    source: 'operator-native-result',
    profile: 'web',
    session: request.host.session,
    routes: [flash, glmFlash, sol].map((route) => ({
      provider: route.provider,
      model: route.model,
      observedAt: stamp,
      result: `${route.provider}/${route.model} — Model\nReasoning efforts:\nmedium (default) — Medium`,
    })),
  };
  request.task.effort = ['medium'];
  assert.equal(advise(request).route.reasoning_effort, 'medium');
  request.task.authorized = request.task.authorized.filter((route) => route.provider !== sol.provider);
  assert.ok(reasons(advise(request)).includes('route-or-data-not-authorized'));
});

test('native capability evidence cannot invent Teams availability or bypass fallback checks', () => {
  const request = fixture([{ ...sol }]);
  const [route] = request.host.routes;
  request.host.session = 'fixture-session';
  request.host.evidence = {
    source: 'operator-native-result',
    profile: 'web',
    session: request.host.session,
    routes: [{ ...route, observedAt: stamp, result: `${route.provider}/${route.model} — Model\nReasoning efforts:\nlow — Low` }],
  };
  for (const surface of ['subagent', 'teams']) {
    request.host.surface = surface;
    request.host.effectiveFallbacks = [];
    for (const value of [undefined, false, true, 'true']) {
      if (value === undefined) delete route.available;
      else route.available = value;
      assert.equal(advise(request).status, value === true || (surface === 'subagent' && value === undefined) ? 'recommend' : 'stop');
    }
    route.available = true;
    delete request.host.effectiveFallbacks;
    assert.equal(advise(request).status, surface === 'teams' ? 'stop' : 'recommend');
    request.host.effectiveFallbacks = [{ provider: flash.provider, model: flash.model }];
    if (surface === 'teams') assert.equal(advise(request).reason, 'native-fallback-unverified-or-enabled');
    else assert.equal(advise(request).status, 'recommend');
  }
});

test('review independence requires actual identities', () => {
  const request = fixture([sol, claude, glm, grok], { role: 'review' });
  request.task.implementers = [
    { provider: 'cross-provider', canonicalModel: sol.canonicalModel },
    { canonicalModel: 'anthropic/claude-opus-5-5' },
  ];
  let result = advise(request);
  assert.equal(result.route.model, glm.model);
  assert.ok(reasons(result).includes('same-model'));
  assert.ok(reasons(result).includes('same-family'));
  request.task.implementers = [{ canonicalModel: 'unverified-model' }];
  assert.equal(advise(request).reason, 'implementation-identity-unverified');
});

test('full setup persists only an explicit local boundary and dry-run leaves state unchanged', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'kitto-boundary-setup-'));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'),
    source = join(root, 'source'),
    bin = join(root, 'bin'),
    kitto = join(home, 'kitto');
  for (const dir of [home, bin, join(source, 'config/dsh'), join(source, 'config/instructions')]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(source, 'config/dsh/AGENTS.md'), 'DSH fixture');
  writeFileSync(join(source, 'config/instructions/common.md'), 'Shared fixture');
  for (const name of ['dsh', 'pnpm']) writeFileSync(join(bin, name), `#!/bin/sh\nprintf "${hosts.dsh.version}\n"\n`, { mode: 0o755 });
  const env = {
    ...process.env,
    HOME: home,
    KITTO_HOME: kitto,
    DSH_HOME: join(home, 'dsh'),
    DSH_AGENTS_HOME: join(home, 'agents'),
    PATH: `${bin}:${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const run = (command, args, cwd = root) => spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 10_000 });
  const good = (result) => assert.equal(result.status, 0, result.stderr + result.stdout);
  for (const args of [['init'], ['add', '.'], ['-c', 'user.name=Kitto', '-c', 'user.email=kitto@example.invalid', 'commit', '-m', 'test']])
    good(run('git', args, source));
  const cli = fileURLToPath(new URL('../dist/bin/kitto.mjs', import.meta.url));
  const setup = (...args) => run(process.execPath, [cli, 'setup', '--agents', 'dsh', '--source', source, ...args]);
  const path = join(kitto, 'state.json');
  good(setup('--routing-boundary', 'company', '--dry-run'));
  assert.equal(existsSync(path), false);
  good(setup('--routing-boundary', 'company'));
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(saved.routingBoundary.mode, 'company');
  assert.equal(saved.routingInstallKind, 'local');
  assert.equal(saved.ready, true);
  assert.ok(existsSync(join(kitto, 'runtime/lib/model-routing.mjs')));
  saved.futureLocalField = { keep: true };
  const baseline = JSON.stringify(saved);
  writeFileSync(path, baseline);
  good(setup('--routing-boundary', 'skip', '--dry-run'));
  assert.equal(readFileSync(path, 'utf8'), baseline);
  good(setup());
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).routingBoundary.mode, 'company');
  good(setup('--routing-boundary', 'skip'));
  const skipped = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(skipped.routingBoundary.mode, 'skip');
  assert.deepEqual(skipped.futureLocalField, { keep: true });
  assert.equal(existsSync(join(env.DSH_HOME, 'cordis.patch.yml')), false);
});

test('Go permit rejects an exact authorization split from its verified pool', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'kitto-approval-split-'));
  t.onTestFinished(() => rmSync(home, { recursive: true, force: true }));
  const dshHome = join(home, 'dsh');
  mkdirSync(dshHome);
  const saved = { ...state(), dshHome },
    pool = 'verified-pool';
  const request = fixture([{ ...grok, pool }]);
  Object.assign(request.host, { version: ROUTING_HOST_VERSION, session: 'fixture-session', spawnVerified: true, effectiveFallbacks: [] });
  Object.assign(request.task, { id: 'verify-fixture', budget: { maxAdditionalCashUsd: 0, maxMonthlyGoFraction: 1 } });
  request.go.pool = pool;
  request.dispatch = { source: 'operator-verified', project: home, callerCwd: home, cwd: home };
  const approve = { ...request.task.authorized[0], premium: true };
  const issue = () => issueRoutePermit({ state: saved, home: dshHome, request, store: createRoutingStore(home), now });
  for (const override of [
    { account: 'other' },
    { accountType: 'company' },
    { billing: 'subscription' },
    { data: 'personal' },
    { canonicalModel: 'xai/other' },
    { premium: false },
  ]) {
    request.task.authorized = [
      { ...approve, pool: 'wrong-pool' },
      { ...approve, ...override, pool },
    ];
    assert.throws(issue, /Dispatch preflight stopped/);
  }
  request.task.authorized = [{ ...approve, pool }];
  assert.equal(issue().status, 'permit-issued');
});
