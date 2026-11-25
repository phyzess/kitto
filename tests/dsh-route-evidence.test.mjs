import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRouteObserver } from '../integration/dsh-route-evidence.mjs';
import { apply } from '../integration/dsh.mjs';
import { applyCapabilityEvidence, parseNativeModelResult } from '../lib/routing-evidence.mjs';

const route = { provider: 'test', model: 'model' };
const raw = 'test/model — Example\nReasoning efforts:\nlow (default) — Low\nhigh — High';
const response = { isError: false, value: raw };
const started = Date.parse('2026-11-25T12:00:00Z');

test('bundle observer is opt-in and ignores unsupported profiles', () => {
  const skills = { registerProvider() {} };
  apply({ skills, inject() { assert.fail('observer must not mount by default'); } });
  apply({ skills, inject(services, start) {
    assert.deepEqual(services, ['profileContext', 'tools']);
    start({ profileContext: { name: 'desktop' }, get tools() { assert.fail('unsupported profile'); } });
  } }, { routeEvidence: true });
});

test('exact native parser rejects listings, wrong IDs, duplicate efforts and fake defaults', () => {
  assert.deepEqual(parseNativeModelResult(route, raw), ['low', 'high']);
  assert.deepEqual(parseNativeModelResult(route, 'test/model — Example\nReasoning efforts:\n(no advertised reasoning efforts)'), []);
  for (const invalid of ['test/model — Example', raw.replace('test/model', 'test/other'), raw + '\nlow — Again',
    raw.replace('high —', 'high (default) —'), raw.replace('low (default)', 'default')]) assert.equal(parseNativeModelResult(route, invalid), null);
});

test('observer exports only exact results for the authenticated caller/session, never payload text', () => {
  let clock = started, enabled = true;
  const observer = createRouteObserver({ profile: 'web', enabled: () => enabled, clock: () => clock });
  const agent = { session: { id: 'session-a' } };
  const exec = { name: 'list_subagent_models', token: Symbol(), agent, arguments: route, signal: new AbortController().signal };
  observer.observe({ ...exec, name: 'read' }, { get value() { assert.fail('unrelated result accessed'); } });
  observer.observe({ ...exec, arguments: { provider: 'test' } }, response);
  observer.observe({ ...exec, token: undefined }, response);
  assert.equal(observer.export(exec).routes.length, 0);
  observer.observe(exec, response);
  const snapshot = observer.export(exec);
  assert.deepEqual(snapshot.routes, [{ ...route, observedAt: new Date(started).toISOString(), reasoningEfforts: ['low', 'high'] }]);
  assert.equal(observer.export({ ...exec, agent: { session: agent.session } }).routes.length, 0);
  agent.session = { id: 'session-b' };
  assert.equal(observer.export(exec).routes.length, 0);
  observer.observe(exec, response);
  observer.observe(exec, { isError: true });
  assert.equal(observer.export(exec).routes.length, 0);
  observer.observe(exec, response);
  clock += 301_000;
  assert.equal(observer.export(exec).routes.length, 0);
  enabled = false;
  assert.equal(observer.export(exec), null);
});

test('import honors row timestamps, session, source and duplicates, not a manual availability override', () => {
  const row = { ...route, observedAt: new Date(started).toISOString(), result: raw };
  const evidence = { source: 'operator-native-result', session: 'session-a', profile: 'web', routes: [row] };
  const host = { surface: 'subagent', session: 'session-a', profile: 'web', routes: [route, { provider: 'test', model: 'other', available: true }], evidence };
  assert.deepEqual(applyCapabilityEvidence(host, started).routes[0].reasoningEfforts, ['low', 'high']);
  assert.equal(applyCapabilityEvidence(host, started).routes[1].available, false);
  for (const invalid of [{ ...evidence, session: 'session-b' }, { ...evidence, routes: [row, row] }, { ...evidence, profile: 'desktop' }]) {
    assert.equal(applyCapabilityEvidence({ ...host, evidence: invalid }, started).routes[0].available, false);
  }
  assert.equal(applyCapabilityEvidence(host, started - 1000).routes[0].available, false);
  assert.equal(applyCapabilityEvidence(host, started + 301_000).routes[0].available, false);
});
