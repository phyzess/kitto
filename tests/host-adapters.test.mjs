import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { adapterFor, planConnect, planDeploy, selectedAdapters } from '../lib/hosts/index.mjs';

const pluginReady = { capabilities: { plugin: true }, actual: '1.0.0' };

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'kitto-adapters-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const state = { agents: ['pi', 'codex', 'dsh'], dshProfile: 'web', source: join(root, 'source'), piHome: join(root, 'pi'),
    codexHome: join(root, 'codex'), dshHome: join(root, 'dsh'), agentsHome: join(root, 'agents'), ...overrides };
  const calls = [];
  const run = (command, args) => { calls.push([command, ...args].join(' ')); return '{}'; };
  const common = { home, run };
  const deps = {
    common,
    pi: { sync: (_state, command, apply) => calls.push(`sync ${command} apply=${apply}`) },
    codex: { inspect: () => pluginReady, syncMcp: async () => { calls.push('codex-mcp apply'); } },
    dsh: { inspect: () => pluginReady, hasPnpm: () => true, syncMcp: async (_state, { dryRun }) => { calls.push(`dsh-mcp dryRun=${dryRun}`); } },
  };
  return { root, home, state, calls, deps };
}

test('connect actions describe exactly the commands apply runs, for every host', async t => {
  const { state, calls, deps } = await fixture(t);
  for (const adapter of selectedAdapters(state, deps)) {
    for (const action of adapter.planConnect(state)) {
      calls.length = 0;
      await action.apply();
      const described = action.describe().split('\n');
      const commands = calls.filter(call => !call.startsWith('sync '));
      const ordered = described.filter(line => commands.includes(line));
      assert.deepEqual(ordered, commands, `${action.host} ${action.kind}`);
    }
  }
});

test('pi plans one pull whose preview is the dry run and whose apply is the real sync', async t => {
  const { state, calls, deps } = await fixture(t);
  const [pull] = adapterFor(state, 'pi', deps).plan(state);
  assert.equal(pull.kind, 'pi-pull');
  assert.equal(pull.phase, 'sync');
  await pull.preview();
  await pull.apply();
  assert.deepEqual(calls, ['sync pull apply=false', 'sync pull apply=true']);
});

test('dsh web plans one MCP sync whose preview is the dry run', async t => {
  const { state, calls, deps } = await fixture(t);
  const [sync] = adapterFor(state, 'dsh', deps).plan(state);
  assert.equal(sync.kind, 'sync-mcp');
  await sync.preview();
  await sync.apply();
  assert.deepEqual(calls, ['dsh-mcp dryRun=true', 'dsh-mcp dryRun=false']);
});

test('deploy plan runs pi before dsh regardless of the agent order and leaves MCP apply after skills', async t => {
  const { state, deps } = await fixture(t, { agents: ['dsh', 'codex', 'pi'] });
  const { sync, postSkills } = planDeploy(state, { deps });
  assert.deepEqual(sync.map(action => action.host), ['pi', 'dsh']);
  assert.deepEqual(postSkills.map(action => `${action.host}:${action.kind}`), ['codex:sync-mcp']);
});

test('dsh desktop plans no bundle, plugin or MCP actions', async t => {
  const { state, deps } = await fixture(t, { agents: ['dsh'], dshProfile: 'Desktop' });
  const adapter = adapterFor(state, 'dsh', deps);
  assert.equal(adapter.desktop, true);
  assert.deepEqual(planDeploy(state, { deps }), { sync: [], postSkills: [] });
  const connect = planConnect(state, { deps });
  const detach = await adapter.planDetach(state);
  for (const action of [...connect, ...detach]) assert.equal(action.kind, 'note');
  assert.equal(adapter.assertConnectable, undefined);
});

test('dsh web refuses to connect without pnpm', async t => {
  const { state, deps } = await fixture(t, { agents: ['dsh'] });
  deps.dsh.hasPnpm = () => false;
  assert.throws(() => adapterFor(state, 'dsh', deps).assertConnectable(), /require pnpm/);
});

test('codex connect skips registration when the CLI has no plugin command', async t => {
  const { state, calls, deps } = await fixture(t, { agents: ['codex'] });
  deps.codex.inspect = () => ({ capabilities: { plugin: false } });
  const warnings = [];
  t.mock.method(console, 'warn', message => warnings.push(message));
  const [register] = adapterFor(state, 'codex', deps).planConnect(state);
  await register.apply();
  assert.deepEqual(calls, []);
  assert.match(warnings[0], /no plugin subcommand/);
});

test('pi detach lists the package removal only when the runtime is registered, and apply runs it', async t => {
  const { state, home, calls, deps } = await fixture(t, { agents: ['pi'] });
  await mkdir(state.piHome, { recursive: true });
  const adapter = adapterFor(state, 'pi', deps);
  assert.deepEqual(await adapter.planDetach(state), []);
  await writeFile(join(state.piHome, 'settings.json'), JSON.stringify({ packages: [join(home, 'runtime')] }));
  const actions = await adapter.planDetach(state);
  assert.deepEqual(actions.map(action => action.kind), ['unregister-package']);
  await actions[0].preview();
  assert.deepEqual(calls, []);
  await actions[0].apply();
  assert.deepEqual(calls, [actions[0].describe()]);
});

test('dsh web detach previews the MCP dry run and resolves the bundle lazily', async t => {
  const { state, calls } = await fixture(t, { agents: ['dsh'] });
  const removals = [];
  const adapter = adapterFor(state, 'dsh', { common: { home: join(state.dshHome, 'kitto-home'), run: (...call) => calls.push(call.flat().join(' ')) },
    dsh: { hasPnpm: () => true, removeMcp: async (_state, options) => { removals.push(options.dryRun); } } });
  const actions = await adapter.planDetach(state);
  assert.deepEqual(actions.map(action => action.kind), ['detach-mcp', 'unregister-bundle']);
  for (const action of actions) await action.preview({ announce: false });
  assert.deepEqual(removals, [true]);
  for (const action of actions) await action.apply();
  assert.deepEqual(removals, [true, false]);
  assert.deepEqual(calls, []);
});
