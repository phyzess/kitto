import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { adviseRoute, auditReview, classifyRoutingFailure } from '../lib/model-routing.mjs';
import { estimateGoFraction, goMeter, goModel, normalizeGoCharge } from '../lib/go-allowance.mjs';
import { hosts } from '../lib/host-pins.mjs';
import { setRoutingBoundary } from '../lib/routing-policy.mjs';
import { parseOptions } from '../lib/kitto.mjs';
import { issueRoutePermit, ROUTING_HOST_VERSION } from '../integration/dsh-routing.mjs';
import { createRoutingStore } from '../lib/routing-state.mjs';

const now = Date.parse('2026-11-25T12:00:00Z');
const stamp = new Date(now).toISOString();
const reset = new Date(now + 3600_000).toISOString();
const sol = { provider: 'openai-codex', model: 'gpt-6.2-sol', canonicalModel: 'openai/gpt-6.2-sol',
  upstream: 'openai-codex', billing: 'subscription', account: 'personal-codex', accountType: 'personal',
  accountVerified: true, available: true, reasoningEfforts: ['low', 'medium', 'high'] };
const claude = { ...sol, upstream: 'anthropic', provider: 'company-claude', model: 'claude-stable',
  canonicalModel: 'anthropic/claude-sonnet-5-5', account: 'corp-claude', accountType: 'company', tier: 1, premium: false };
const router = { ...claude, upstream: 'openrouter', provider: 'corp-router', account: 'corp-router-plan' };
const makeGo = (model, canonicalModel, reasoningEfforts) => ({ ...sol, provider: 'opencode-go', upstream: 'opencode-go',
  billing: 'go-included', account: 'my-go', model, canonicalModel, reasoningEfforts });
const flash = makeGo('deepseek-v4.1-flash', 'deepseek/deepseek-v4.1-flash-1017', ['low', 'high']);
const glmFlash = makeGo('glm-5.3-flash', 'zhipuai/glm-5.3-flash', ['low', 'medium']);
const glm = makeGo('glm-5.3', 'zhipuai/glm-5.3', ['low', 'medium']);
const grok = makeGo('grok-4.7', 'xai/grok-4.7', ['low', 'high']);
const goEntry = (route, monthly, plus, teams, input, output) => ({ id: route.model, canonical_id: route.canonicalModel,
  type: 'chat', go: { monthly_usage: { go: monthly, 'go-plus': plus, 'go-teams': teams }, training: false },
  cost: { text: { input: { price: input }, output: { price: output } } } });
const goFixture = () => ({ plan: 'go', account: 'my-go', extraUsage: 'off', observedAt: stamp, catalogObservedAt: stamp,
  usage: Object.fromEntries(['rolling', 'weekly', 'monthly'].map(key => [key, { status: 'ok', percent: 10, resetsAt: reset }])),
  catalog: { object: 'list', data: [goEntry(flash, 100, 200, 105, 0.15, 0.60), goEntry(glmFlash, 60, 180, 65, 0.15, 0.50),
    goEntry(glm, 200, 400, 205, 1.4, 4.4), goEntry(grok, 15, 60, 20, 2, 6)] } });

function state(mode = 'personal', custom) {
  const value = { schema: 1, routingInstallKind: 'local', ready: true, agents: ['dsh'], dshProfile: 'web', preserveMe: 42 };
  setRoutingBoundary(value, mode, custom);
  return value;
}
function fixture(routes = [flash, glmFlash], options = {}) {
  const { role = 'verify', data = 'public', surface = 'subagent', effects = 'read' } = options;
  return { host: { kind: 'dsh', installation: 'full-local', profile: 'web', surface, observedAt: stamp, routes,
    ...(surface === 'teams' && { effectiveFallbacks: [] }) },
  task: { role, data, effects, effort: ['low'], tokens: { input: 10_000, output: 1_000 },
    authorized: routes.map(({ provider, model, canonicalModel, upstream, billing, account, accountType }) =>
      ({ provider, model, canonicalModel, upstream, billing, account, accountType, data })) }, go: goFixture() };
}
const advise = (request, saved = state(), operation = 'preflight') => adviseRoute({ request, state: saved, now, operation });
const reasons = result => result.rejected.map(row => row.reason);

test('missing, skipped, damaged, copied and non-local device confirmations stop', () => {
  const request = fixture();
  for (const saved of [null, {}, state('skip'), { ...state(), ready: false }, { ...state(), routingInstallKind: 'service' },
    { ...state(), routingBoundary: { ...state().routingBoundary, identity: 'another-machine' } },
    { ...state(), routingBoundary: { ...state().routingBoundary, routes: [flash.model] } }]) {
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
  for (const invalid of [{ ...router, billing: 'payg' }, { ...router, upstream: 'unknown' }, { ...router, accountVerified: false }]) {
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
    missing: request => { delete request.go.usage; },
    stale: request => { request.go.observedAt = '2026-11-25T11:00:00Z'; },
    invalid: request => { delete request.go.usage.monthly; },
    exhausted: request => { request.go.usage.rolling = { status: 'rate-limited', percent: 99, resetsAt: reset }; },
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
  assert.deepEqual(reasons(advise(request)), ['effort-unavailable', 'unavailable-or-not-allowed',
    'upstream-or-model-metadata-unverified', 'premium-not-approved']);
  request.task.effort = ['default'];
  assert.ok(!Object.hasOwn(advise(request).route, 'reasoning_effort'));
  request.host.surface = 'teams';
  assert.equal(advise(request).reason, 'native-fallback-unverified-or-enabled');
  request.host.effectiveFallbacks = [{ provider: sol.provider, model: sol.model }];
  assert.equal(advise(request).reason, 'native-fallback-unverified-or-enabled');
  request.host.effectiveFallbacks = [];
  assert.equal(advise(request).route.reasoning_effort, 'default');
});

test('only one read-only reselection can choose another already approved route', () => {
  const request = fixture([flash, glmFlash, sol], { effects: 'write' });
  request.failure = { route: flash, status: 429, checkpointConfirmed: true };
  assert.equal(advise(request, state(), 'reselect').reason, 'manual-new-work-item-required');
  request.task.effects = 'read';
  let result = advise(request, state(), 'reselect');
  assert.equal(result.failureClass, 'go-pool-quota');
  assert.equal(result.status, 'stop');
  assert.ok(reasons(result).includes('go-pool-quota'));
  request.attempted = [{ ...flash, status: 429 }];
  request.failure = { route: sol, kind: 'timeout' };
  assert.equal(advise(request, state(), 'reselect').reason, 'reselection-limit-reached');
  delete request.attempted;
  request.failure = { route: glmFlash, kind: 'model-rate-limit', status: 429 };
  request.host.routes = [flash];
  request.task.effort = ['high', 'low'];
  result = advise(request, state(), 'reselect');
  assert.equal(result.failureClass, 'route');
  assert.equal(result.route.reasoning_effort, 'high');
  assert.equal(classifyRoutingFailure({ status: 403 }, flash), 'configuration');
  assert.equal(classifyRoutingFailure({ status: 503 }, flash), 'transient');
  assert.equal(classifyRoutingFailure({ status: 500 }, flash), 'unknown');
});

test('built-in short names cannot inherit a lower tier from a same-family catalog remap', () => {
  const disguised = { ...flash, canonicalModel: 'deepseek/deepseek-v4-pro' };
  const request = fixture([disguised]);
  request.go.catalog.data[0].canonical_id = disguised.canonicalModel;
  assert.deepEqual(reasons(advise(request)), ['upstream-or-model-metadata-unverified']);
  const external = { ...router, canonicalModel: disguised.canonicalModel, tier: 0 };
  assert.deepEqual(reasons(advise(fixture([external]))), ['premium-not-approved']);
});

test('one quota failure freezes other models for native and custom provider IDs', () => {
  for (const previous of [flash, { ...flash, provider: 'my-go-alias' }]) {
    const request = fixture([previous, glmFlash, sol]);
    request.host.routes = [glmFlash, sol];
    for (const cause of [{ kind: 'go-pool-quota' }, { status: 429 }]) {
      request.failure = { route: previous, ...cause };
      const result = advise(request, state(), 'reselect');
      assert.equal(result.status, 'stop');
      assert.ok(reasons(result).includes('go-pool-quota'));
    }
    for (const override of [{ upstream: undefined }, { account: undefined }, { upstream: 'openrouter' }, { account: 'other' }]) {
      request.failure = { route: { ...previous, ...override }, kind: 'go-pool-quota' };
      assert.equal(advise(request, state(), 'reselect').reason, 'failed-route-unverified');
    }
    request.failure = { route: previous, status: 429 };
    request.host.routes.push({ ...previous, account: 'new-binding' });
    assert.equal(advise(request, state(), 'reselect').reason, 'failed-route-unverified');
  }
});

test('authentication failures block aliases and a reselection cannot switch account boundary', () => {
  const blockedAlias = { ...claude, provider: 'second-claude-alias', model: 'different-short-name' };
  const healthy = { ...claude, provider: 'other-claude-account', account: 'other-company-account' };
  const request = fixture([claude, blockedAlias, sol, healthy], { role: 'implement' });
  request.failure = { route: claude, status: 403 };
  const result = advise(request, state(), 'reselect');
  assert.equal(result.route.provider, healthy.provider);
  assert.equal(result.rejected.find(item => item.provider === blockedAlias.provider).reason, 'failed-upstream-account');
  assert.equal(result.rejected.find(item => item.provider === sol.provider).reason, 'reselection-escalation');
  request.attempted = [{ ...claude, status: 403 }];
  assert.equal(advise(request, state(), 'reselect').reason, 'reselection-limit-reached');
  request.attempted[0].account = undefined;
  assert.equal(advise(request, state(), 'reselect').reason, 'attempt-history-unverified');
});

test('native capability imports supply exact effort without changing authorization or pool holds', () => {
  const request = fixture([flash, glmFlash, sol]);
  request.host.session = 'fixture-session';
  request.host.evidence = { source: 'operator-native-result', profile: 'web', session: request.host.session,
    routes: [flash, glmFlash, sol].map(route => ({ provider: route.provider, model: route.model, observedAt: stamp,
      result: `${route.provider}/${route.model} — Model\nReasoning efforts:\nmedium (default) — Medium` })) };
  request.task.effort = ['medium'];
  assert.equal(advise(request).route.reasoning_effort, 'medium');
  request.task.authorized = request.task.authorized.filter(route => route.provider !== sol.provider);
  request.failure = { route: flash, status: 429 };
  const blocked = advise(request, state(), 'reselect');
  assert.equal(blocked.status, 'stop');
  assert.ok(reasons(blocked).includes('go-pool-quota'));
  assert.ok(reasons(blocked).includes('route-or-data-not-authorized'));
});

test('native capability evidence cannot invent Teams availability or bypass fallback checks', () => {
  const request = fixture([{ ...sol }]);
  const [route] = request.host.routes;
  request.host.session = 'fixture-session';
  request.host.evidence = { source: 'operator-native-result', profile: 'web', session: request.host.session,
    routes: [{ ...route, observedAt: stamp, result: `${route.provider}/${route.model} — Model\nReasoning efforts:\nlow — Low` }] };
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

test('quality failure requires human review and independence requires actual identities', () => {
  const request = fixture([sol, claude, glm, grok], { role: 'review' });
  request.task.implementers = [{ provider: 'cross-provider', canonicalModel: sol.canonicalModel },
    { canonicalModel: 'anthropic/claude-opus-5-5' }];
  let result = advise(request);
  assert.equal(result.route.model, glm.model);
  assert.ok(reasons(result).includes('same-model'));
  assert.ok(reasons(result).includes('same-family'));
  assert.equal(auditReview(request.task.implementers, claude).independent, false);
  request.failure = { route: glm, kind: 'quality' };
  assert.equal(advise(request, state(), 'reselect').reason, 'manual-failure-review-required');
  request.task.authorized[3].premium = true;
  result = advise(request, state(), 'reselect');
  assert.equal(result.failureClass, 'quality');
  assert.equal(result.reason, 'manual-failure-review-required');
  request.task.implementers = [{ canonicalModel: 'unverified-model' }];
  assert.equal(advise(request).reason, 'implementation-identity-unverified');
});

test('CLI reads only local files and reports stop without exposing extra payload fields', t => {
  const home = mkdtempSync(join(tmpdir(), 'kitto-routing-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const statePath = join(home, 'state.json');
  const input = join(home, 'input.json');
  const saved = { ...state('company'), dshHome: join(home, 'dsh') };
  const original = JSON.stringify(saved);
  const request = fixture([claude], { role: 'implement', surface: 'teams', data: 'internal' });
  request.host.observedAt = new Date().toISOString();
  request.secret = 'not echoed by CLI';
  writeFileSync(statePath, original);
  writeFileSync(input, JSON.stringify(request));
  const cli = () => spawnSync(process.execPath, [fileURLToPath(new URL('../bin/kitto.mjs', import.meta.url)), 'route', 'preflight', '--input', input],
    { env: { ...process.env, KITTO_HOME: home, DSH_HOME: saved.dshHome, DSH_PROFILE: 'web' }, encoding: 'utf8', timeout: 5000 });
  const result = cli();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).route.model, claude.model);
  assert.doesNotMatch(result.stdout, /not echoed/);
  assert.equal(readFileSync(statePath, 'utf8'), original);
  writeFileSync(statePath, '{}');
  const blocked = cli();
  assert.equal(blocked.status, 2, blocked.stderr);
  assert.equal(JSON.parse(blocked.stdout).status, 'stop');
});

test('full setup persists only an explicit local boundary and dry-run leaves state unchanged', t => {
  const root = mkdtempSync(join(tmpdir(), 'kitto-boundary-setup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'), source = join(root, 'source'), bin = join(root, 'bin'), kitto = join(home, 'kitto');
  for (const dir of [home, bin, join(source, 'config/dsh'), join(source, 'config/instructions')]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(source, 'config/dsh/AGENTS.md'), 'DSH fixture');
  writeFileSync(join(source, 'config/instructions/common.md'), 'Shared fixture');
  for (const name of ['dsh', 'pnpm']) writeFileSync(join(bin, name), `#!/bin/sh\nprintf "${hosts.dsh.version}\n"\n`, { mode: 0o755 });
  const env = { ...process.env, HOME: home, KITTO_HOME: kitto, DSH_HOME: join(home, 'dsh'), DSH_AGENTS_HOME: join(home, 'agents'),
    PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const run = (command, args, cwd = root) => spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 10_000 });
  const good = result => assert.equal(result.status, 0, result.stderr + result.stdout);
  for (const args of [['init'], ['add', '.'], ['-c', 'user.name=Kitto', '-c', 'user.email=kitto@example.invalid', 'commit', '-m', 'test']]) good(run('git', args, source));
  const cli = fileURLToPath(new URL('../bin/kitto.mjs', import.meta.url));
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


test('Go permit rejects an exact authorization split from its verified pool', t => {
  const home = mkdtempSync(join(tmpdir(), 'kitto-approval-split-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const dshHome = join(home, 'dsh');
  mkdirSync(dshHome);
  const saved = { ...state(), dshHome }, pool = 'verified-pool';
  const request = fixture([{ ...grok, pool }]);
  Object.assign(request.host, { version: ROUTING_HOST_VERSION, session: 'fixture-session', spawnVerified: true, effectiveFallbacks: [] });
  Object.assign(request.task, { id: 'verify-fixture', budget: { maxAdditionalCashUsd: 0, maxMonthlyGoFraction: 1 } });
  request.go.pool = pool;
  request.dispatch = { source: 'operator-verified', project: home, callerCwd: home, cwd: home };
  const approve = { ...request.task.authorized[0], premium: true };
  const issue = () => issueRoutePermit({ state: saved, home: dshHome, request, store: createRoutingStore(home), now });
  for (const override of [{ account: 'other' }, { accountType: 'company' }, { billing: 'subscription' },
    { data: 'personal' }, { canonicalModel: 'xai/other' }, { premium: false }]) {
    request.task.authorized = [{ ...approve, pool: 'wrong-pool' }, { ...approve, ...override, pool }];
    assert.throws(issue, /Dispatch preflight stopped/);
  }
  request.task.authorized = [{ ...approve, pool }];
  assert.equal(issue().status, 'permit-issued');
});

test('reselection bounds same-tier Go cost using evidence and the supplied task cap', () => {
  const request = fixture();
  request.failure = { route: flash, kind: 'model-rate-limit' };
  const result = () => advise(request, state(), 'reselect');
  assert.ok(reasons(result()).includes('reselection-go-cost-escalation'));
  request.failure.route = glmFlash;
  assert.equal(result().route.model, flash.model);
  request.task.budget = { maxAdditionalCashUsd: 0, maxMonthlyGoFraction: 0.000001 };
  assert.ok(reasons(result()).includes('go-exceeds-approved-budget'));
  request.task.budget.maxMonthlyGoFraction = 0.001;
  assert.equal(result().route.model, flash.model);
  request.go.catalog.data[1].cost.text.output.price = 'invalid';
  assert.ok(reasons(result()).includes('reselection-go-cost-unverified'));
  request.task.budget.maxAdditionalCashUsd = -1;
  assert.equal(result().reason, 'invalid-task-budget');
});

test('CLI preflight and reselect cannot use Go without a stable shared pool binding', t => {
  const home = mkdtempSync(join(tmpdir(), 'kitto-shared-route-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const saved = { ...state(), dshHome: join(home, 'dsh') };
  const [statePath, input] = ['state.json', 'input.json'].map(name => join(home, name));
  writeFileSync(statePath, JSON.stringify(saved));
  const request = fixture([glmFlash, flash]);
  const observedAt = new Date().toISOString(), resetsAt = new Date(Date.now() + 3600_000).toISOString();
  request.host.observedAt = request.go.observedAt = request.go.catalogObservedAt = observedAt;
  for (const window of Object.values(request.go.usage)) window.resetsAt = resetsAt;
  const cli = (operation, status) => {
    writeFileSync(input, JSON.stringify(request));
    const output = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/kitto.mjs', import.meta.url)), 'route', operation, '--input', input],
      { env: { ...process.env, KITTO_HOME: home, DSH_HOME: saved.dshHome, DSH_PROFILE: 'web' }, encoding: 'utf8', timeout: 5000 });
    assert.equal(output.status, status, output.stderr);
    return JSON.parse(output.stdout);
  };
  assert.ok(reasons(cli('preflight', 2)).includes('go-pool-unverified'));
  request.failure = { route: glmFlash, kind: 'model-rate-limit' };
  assert.ok(reasons(cli('reselect', 2)).includes('go-pool-unverified'));
  const own = fixture([sol]);
  request.host.routes = [...request.host.routes, ...own.host.routes];
  request.task.authorized.push(...own.task.authorized);
  assert.equal(cli('preflight', 0).route.model, sol.model);
  assert.equal(cli('reselect', 2).reason, 'no-eligible-route');
  const independent = { ...router, accountType: 'personal', tier: 0 };
  request.host.routes.push(independent);
  request.task.authorized.push({ ...independent, data: 'public' });
  assert.equal(cli('reselect', 0).route.provider, independent.provider);
  request.host.routes.pop();
  request.task.authorized.pop();
  request.go.pool = 'verified-pool';
  request.host.routes = request.host.routes.map(row => row.upstream === 'opencode-go' ? { ...row, pool: request.go.pool } : row);
  request.task.authorized = request.task.authorized.map(row => row.upstream === 'opencode-go' ? { ...row, pool: request.go.pool } : row);
  assert.equal(cli('reselect', 0).route.model, flash.model);
});
