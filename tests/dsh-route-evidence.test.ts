import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createRouteObserver } from '../integration/dsh-route-evidence.ts';
import { apply } from '../integration/dsh.ts';
import { applyCapabilityEvidence, parseNativeModelResult } from '../lib/routing-evidence.ts';
import type { DshPluginContext } from '../types/kitto.d.ts';

type Json = Record<string, any>;

const route = { provider: 'test', model: 'model' };
const raw = 'test/model — Example\nReasoning efforts:\nlow (default) — Low\nhigh — High';
const response = { isError: false, value: raw };
const started = Date.parse('2026-11-25T12:00:00Z');

function pluginContext(fake: Partial<DshPluginContext>): DshPluginContext {
  return fake as DshPluginContext;
}

function exported(observer: ReturnType<typeof createRouteObserver>, exec: Json) {
  const snapshot = observer.export(exec);
  assert.ok(snapshot);
  return snapshot;
}

function applied(host: Json, now: number): Json {
  const result = applyCapabilityEvidence(host, now);
  assert.ok(result);
  return result;
}

test('bundle observer is opt-in and ignores unsupported profiles', () => {
  let injections = 0;
  const ctx = pluginContext({
    skills: { registerProvider() {} },
    inject(services: string[], start: (host: Json) => unknown) {
      injections++;
      assert.deepEqual(services, ['profileContext', 'tools']);
      start({
        profileContext: { name: 'desktop' },
        get tools() {
          return assert.fail('unsupported profile');
        },
      });
    },
  });
  apply(ctx);
  assert.equal(injections, 1, 'only the task-route planner mounts by default');
  apply(ctx, { routeEvidence: true });
  assert.equal(injections, 3, 'observer mounts only when explicitly enabled');
});

test('exact native parser rejects listings, wrong IDs, duplicate efforts and fake defaults', () => {
  assert.deepEqual(parseNativeModelResult(route, raw), ['low', 'high']);
  assert.deepEqual(parseNativeModelResult(route, 'test/model — Example\nReasoning efforts:\n(no advertised reasoning efforts)'), []);
  for (const invalid of [
    'test/model — Example',
    raw.replace('test/model', 'test/other'),
    raw + '\nlow — Again',
    raw.replace('high —', 'high (default) —'),
    raw.replace('low (default)', 'default'),
  ])
    assert.equal(parseNativeModelResult(route, invalid), null);
});

test('observer exports only exact results for the authenticated caller/session, never payload text', () => {
  let clock = started,
    enabled = true;
  const observer = createRouteObserver({ profile: 'web', enabled: () => enabled, clock: () => clock });
  const agent = { session: { id: 'session-a' } };
  const exec = { name: 'list_subagent_models', token: Symbol(), agent, arguments: route, signal: new AbortController().signal };
  observer.observe(
    { ...exec, name: 'read' },
    {
      get value() {
        return assert.fail('unrelated result accessed');
      },
    },
  );
  observer.observe({ ...exec, arguments: { provider: 'test' } }, response);
  observer.observe({ ...exec, token: undefined }, response);
  assert.equal(exported(observer, exec).routes.length, 0);
  observer.observe(exec, response);
  const snapshot = exported(observer, exec);
  assert.deepEqual(snapshot.routes, [{ ...route, observedAt: new Date(started).toISOString(), reasoningEfforts: ['low', 'high'] }]);
  assert.equal(exported(observer, { ...exec, agent: { session: agent.session } }).routes.length, 0);
  agent.session = { id: 'session-b' };
  assert.equal(exported(observer, exec).routes.length, 0);
  observer.observe(exec, response);
  observer.observe(exec, { isError: true });
  assert.equal(exported(observer, exec).routes.length, 0);
  observer.observe(exec, response);
  clock += 301_000;
  assert.equal(exported(observer, exec).routes.length, 0);
  enabled = false;
  assert.equal(observer.export(exec), null);
});

test('import honors row timestamps, session, source and duplicates, not a manual availability override', () => {
  const row = { ...route, observedAt: new Date(started).toISOString(), result: raw };
  const evidence = { source: 'operator-native-result', session: 'session-a', profile: 'web', routes: [row] };
  const host = {
    surface: 'subagent',
    session: 'session-a',
    profile: 'web',
    routes: [route, { provider: 'test', model: 'other', available: true }],
    evidence,
  };
  assert.deepEqual(applied(host, started).routes[0].reasoningEfforts, ['low', 'high']);
  assert.equal(applied(host, started).routes[1].available, false);
  for (const invalid of [
    { ...evidence, session: 'session-b' },
    { ...evidence, routes: [row, row] },
    { ...evidence, profile: 'desktop' },
  ]) {
    assert.equal(applied({ ...host, evidence: invalid }, started).routes[0].available, false);
  }
  assert.equal(applied(host, started - 1000).routes[0].available, false);
  assert.equal(applied(host, started + 301_000).routes[0].available, false);
});
