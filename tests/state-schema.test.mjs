import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CURRENT_SCHEMA, downgradeState, importedPiPackages, loadState, migrateState, rollbackState, saveState,
} from '../lib/state-schema.mjs';
import { get, list } from '../lib/ownership.mjs';
import { activeRoutingBoundary, setRoutingBoundary } from '../lib/routing-policy.mjs';

const block = '<!-- kitto:begin -->\nrules\n<!-- kitto:end -->\n';

function v1() {
  return {
    schema: 1, ready: true, detached: false, removing: false, removedAgents: [],
    source: '/home/u/kitto-config', agents: ['pi', 'codex', 'dsh'], dshProfile: 'web',
    agentsHome: '/home/u/.agents', piHome: '/home/u/.pi/agent', codexHome: '/home/u/.codex', dshHome: '/home/u/.dsh',
    version: '0.4.0', keepExistingSkills: true,
    skills: { review: 'sha-review', plan: 'sha-plan' },
    hostSkills: { pi: { 'pi-only': 'sha-pi' }, codex: {} },
    keptSkills: { shared: ['mine'], pi: ['host-mine'] },
    instructions: { codex: block, dsh: block },
    mcp: { codex: { docs: 'fp-docs', search: 'fp-search' }, codexPending: { search: 'fp-search-next', fresh: 'fp-fresh' } },
    routingBoundary: { schema: 1, mode: 'local' },
  };
}

function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'kitto-state-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('v1 to v2 moves every ownership record and drops the old fields', () => {
  const { state, changed } = migrateState(v1());
  assert.equal(changed, true);
  assert.equal(state.schema, CURRENT_SCHEMA);
  for (const field of ['skills', 'hostSkills', 'keptSkills', 'instructions', 'mcp']) assert.equal(field in state, false, field);
  assert.equal(state.keepExistingSkills, true);
  assert.deepEqual(state.routingBoundary, { schema: 1, mode: 'local' });
  assert.deepEqual(get(state, 'skill', 'shared', 'review'), { hash: 'sha-review', status: 'owned' });
  assert.deepEqual(get(state, 'skill', 'shared', 'mine'), { hash: null, status: 'kept' });
  assert.deepEqual(get(state, 'skill', 'pi', 'pi-only'), { hash: 'sha-pi', status: 'owned' });
  assert.deepEqual(get(state, 'instructions', 'dsh', 'agents-md'), { hash: block, status: 'owned' });
  assert.deepEqual(get(state, 'mcp', 'codex', 'docs'), { hash: 'fp-docs', status: 'owned' });
  assert.deepEqual(get(state, 'mcp', 'codex', 'search'), { hash: 'fp-search-next', status: 'pending', previous: 'fp-search' });
  assert.deepEqual(get(state, 'mcp', 'codex', 'fresh'), { hash: 'fp-fresh', status: 'pending' });
});

test('migration does not mutate its input and is idempotent', () => {
  const input = v1();
  const copy = structuredClone(input);
  const once = migrateState(input);
  assert.deepEqual(input, copy);
  const twice = migrateState(once.state);
  assert.equal(twice.changed, false);
  assert.deepEqual(twice.state, once.state);
});

test('round trip v1 to v2 to v1 is exact for realistic and degenerate fixtures', () => {
  const sparse = { schema: 1, ready: false, agents: ['pi'] };
  const empties = { schema: 1, skills: {}, hostSkills: {}, keptSkills: {}, instructions: {}, mcp: { codex: {} } };
  const noPendingKey = { schema: 1, skills: { a: 'h' }, hostSkills: { pi: {}, codex: { c: 'h' } }, mcp: { codex: { x: 'f' } } };
  const keptOnlyGroup = { schema: 1, skills: {}, hostSkills: {}, keptSkills: { codex: ['mine'] } };
  const otherMcp = { schema: 1, mcp: { other: { a: 1 }, codex: { x: 'f' } } };
  const pendingOnly = { schema: 1, mcp: { codexPending: { y: 'f' } } };
  for (const fixture of [v1(), sparse, empties, noPendingKey, keptOnlyGroup, otherMcp, pendingOnly]) {
    const migrated = migrateState(fixture).state;
    assert.deepEqual(downgradeState(migrated), fixture);
    assert.deepEqual(downgradeState(structuredClone(migrated)), fixture);
  }
});

test('a missing schema field is treated as v1', () => {
  const { schema, ...legacy } = v1();
  const { state } = migrateState(legacy);
  assert.equal(state.schema, CURRENT_SCHEMA);
  assert.deepEqual(downgradeState(state), { ...legacy, schema: 1 });
});

test('an entry that is both owned and kept stays owned', () => {
  const { state } = migrateState({ schema: 1, skills: { a: 'h' }, keptSkills: { shared: ['a', 'b'] } });
  assert.deepEqual(list(state, 'skill', 'shared').map(entry => `${entry.name}:${entry.status}`), ['a:owned', 'b:kept']);
});

test('unknown and malformed schemas are refused', async () => {
  assert.throws(() => migrateState({ schema: 3 }), /Unsupported Kitto state schema 3.*Upgrade Kitto/);
  assert.throws(() => migrateState({ schema: 'two' }), /Unsupported/);
  assert.throws(() => migrateState([]), /JSON object/);
  assert.throws(() => downgradeState({ schema: 99 }), /Unsupported/);
  await assert.rejects(saveState('/unused', { schema: 1 }), /migrate it first/);
});

test('downgrade refuses ownership that schema 1 cannot express', () => {
  const base = migrateState({ schema: 1 }).state;
  const dsh = structuredClone(base);
  dsh.owned = { mcp: { dsh: { row: { hash: 'h', status: 'owned' } } } };
  assert.deepEqual(downgradeState(dsh), downgradeState(base), 'schema 1 never recorded DSH rows, so nothing is lost');
  const foreign = structuredClone(base);
  foreign.owned = { mcp: { pi: { row: { hash: 'h', status: 'owned' } } } };
  assert.throws(() => downgradeState(foreign), /mcp scope pi/);
  const pending = structuredClone(base);
  pending.owned = { skill: { shared: { a: { hash: 'h', status: 'pending' } } } };
  assert.throws(() => downgradeState(pending), /pending skill/);
});

test('pi managed packages are imported and reported as removable', t => {
  const dir = temp(t);
  const file = join(dir, 'managed-packages.json');
  const specs = ['npm:pi-foo@1.2.0', { source: 'git:github.com/acme/tool.git@main', extensions: ['a'] }];
  writeFileSync(file, JSON.stringify(specs));
  const result = migrateState(v1(), { piLocalDir: dir });
  assert.deepEqual(result.removable, [file]);
  assert.deepEqual(list(result.state, 'pi-package', 'pi').map(entry => entry.name), ['npm:pi-foo', 'github.com/acme/tool']);
  assert.deepEqual(importedPiPackages(result.state), specs);
  assert.equal(downgradeState(result.state).owned, undefined);
  assert.deepEqual(downgradeState(result.state), v1());
  const again = migrateState(result.state, { piLocalDir: dir });
  assert.deepEqual(again.removable, [file]);
  rmSync(file);
  assert.deepEqual(migrateState(result.state, { piLocalDir: dir }).removable, []);
});

test('pi import tolerates a missing file and rejects a malformed one', t => {
  const dir = temp(t);
  assert.deepEqual(migrateState(v1(), { piLocalDir: dir }).removable, []);
  writeFileSync(join(dir, 'managed-packages.json'), '{"not":"a list"}');
  assert.throws(() => migrateState(v1(), { piLocalDir: dir }), /expected a JSON array/);
  writeFileSync(join(dir, 'managed-packages.json'), '{');
  assert.throws(() => migrateState(v1(), { piLocalDir: dir }), /Cannot import/);
});

test('loadState migrates on disk and writes the v1 backup exactly once', async t => {
  const dir = temp(t);
  const path = join(dir, 'state.json');
  const original = JSON.stringify(v1(), null, 2) + '\n';
  writeFileSync(path, original);
  const first = await loadState(path);
  assert.equal(first.wrote, true);
  assert.equal(first.backup, true);
  assert.equal(readFileSync(join(dir, 'state.v1.json'), 'utf8'), original);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).schema, CURRENT_SCHEMA);
  assert.deepEqual(readdirSync(dir).sort(), ['state.json', 'state.v1.json']);
  const second = await loadState(path);
  assert.equal(second.wrote, false);
  assert.equal(second.backup, false);
  writeFileSync(path, JSON.stringify({ ...v1(), version: '9.9.9' }));
  const third = await loadState(path);
  assert.equal(third.wrote, true);
  assert.equal(third.backup, false);
  assert.equal(readFileSync(join(dir, 'state.v1.json'), 'utf8'), original);
});

test('dry run reads and migrates in memory without touching disk', async t => {
  const dir = temp(t);
  const path = join(dir, 'state.json');
  const original = JSON.stringify(v1());
  writeFileSync(path, original);
  const result = await loadState(path, { dryRun: true });
  assert.equal(result.changed, true);
  assert.equal(result.state.schema, CURRENT_SCHEMA);
  assert.equal(result.wrote, false);
  assert.equal(readFileSync(path, 'utf8'), original);
  assert.equal(existsSync(join(dir, 'state.v1.json')), false);
  assert.equal(await saveState(path, result.state, { dryRun: true }), false);
  assert.equal(readFileSync(path, 'utf8'), original);
  assert.equal((await rollbackState(path, { dryRun: true })).wrote, false);
});

test('loadState returns undefined for a missing file and refuses a future schema on disk', async t => {
  const dir = temp(t);
  const path = join(dir, 'state.json');
  assert.equal(await loadState(path), undefined);
  assert.equal(await rollbackState(path), undefined);
  writeFileSync(path, JSON.stringify({ schema: 7 }));
  await assert.rejects(loadState(path), /Unsupported Kitto state schema 7/);
  assert.equal(readFileSync(path, 'utf8'), '{"schema":7}');
  assert.equal(existsSync(join(dir, 'state.v1.json')), false);
});

test('saveState persists v2 atomically and rollbackState restores v1', async t => {
  const dir = temp(t);
  const path = join(dir, 'state.json');
  const { state } = migrateState(v1());
  assert.equal(await saveState(path, state), true);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), state);
  assert.deepEqual(readdirSync(dir), ['state.json']);
  const rolled = await rollbackState(path);
  assert.equal(rolled.wrote, true);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), v1());
});

test('routing accepts schema 1 and schema 2 states but nothing else', () => {
  const state = { schema: 1, routingInstallKind: 'local', ready: true, agents: ['dsh'], dshProfile: 'web' };
  setRoutingBoundary(state, 'personal');
  assert.equal(state.routingBoundary.schema, 1);
  assert.ok(activeRoutingBoundary(state, 'web'));
  assert.ok(activeRoutingBoundary({ ...state, schema: CURRENT_SCHEMA }, 'web'));
  assert.equal(activeRoutingBoundary({ ...state, schema: 3 }, 'web'), null);
});
