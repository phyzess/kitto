import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyCodexMcp, planCodexMcp, removeCodexMcp, sourceServers, sourceTransport, transportHash,
} from '../lib/codex-mcp.mjs';

// The fake Codex CLI records argv and keeps a small JSON config. It never starts
// a server, contacts a network or runs a model.
const root = fileURLToPath(new URL('../', import.meta.url));
const fakeAgent = join(root, 'tests/helpers/fake-agent.cjs');

function fixture(t) {
  const temp = mkdtempSync(join(tmpdir(), 'kitto-codex-mcp-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const bin = join(temp, 'bin'), codexHome = join(temp, 'codex'), source = join(temp, 'source');
  for (const dir of [bin, codexHome, join(source, 'config/pi')]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(bin, 'codex'), `#!${process.execPath}\nrequire(${JSON.stringify(fakeAgent)});\n`, { mode: 0o755 });
  const log = join(temp, 'calls.jsonl');
  const env = {
    ...process.env, HOME: join(temp, 'home'), KITTO_HOME: join(temp, 'kitto'), CODEX_HOME: codexHome,
    CALL_LOG: log, PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  };
  const run = (args, options = {}) => {
    const result = spawnSync('codex', args, { env, encoding: 'utf8', timeout: 15_000, ...options });
    if (result.error || result.status !== 0) {
      throw new Error(result.error?.message || result.stderr?.trim() || `codex exited ${result.status}`);
    }
    return result.stdout.trim();
  };
  const stateFile = join(codexHome, '_fake-codex.json');
  const codexState = () => existsSync(stateFile)
    ? JSON.parse(readFileSync(stateFile, 'utf8'))
    : { mcpServers: {} };
  const saveCodex = data => {
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(stateFile, JSON.stringify(data));
  };
  const writeSource = servers => {
    writeFileSync(join(source, 'config/pi/mcp.json'), JSON.stringify({ mcpServers: servers }));
  };
  const calls = () => existsSync(log)
    ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    : [];
  const mcpCalls = action => calls().filter(call => call.command === 'codex'
    && call.args[0] === 'mcp' && call.args[1] === action);
  const state = (owned = {}) => ({ source, codexHome, agents: ['codex'], mcp: { codex: { ...owned } } });
  const plan = async current => {
    const lines = [];
    const operations = await planCodexMcp(current, {
      run, env, home: codexHome, platform: 'linux', log: line => lines.push(line),
    });
    return { operations, lines };
  };
  const apply = async current => {
    const warnings = [];
    const operations = await applyCodexMcp(current, {
      run, env, home: codexHome, platform: 'linux',
      save: async () => writeFileSync(join(temp, 'state.json'), JSON.stringify(current)),
      warn: line => warnings.push(line),
    });
    return { operations, warnings };
  };
  const git = (...args) => {
    const result = spawnSync('git', ['-C', source, ...args], { env, encoding: 'utf8', timeout: 15_000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  };
  const initSource = () => {
    for (const args of [['init', '-b', 'main'], ['config', 'user.email', 'test@example.invalid'],
      ['config', 'user.name', 'Kitto test'], ['add', '.'], ['commit', '-m', 'fixture']]) git(...args);
  };
  const cli = (...args) => spawnSync(process.execPath, [join(root, 'bin/kitto.mjs'), ...args], {
    env, encoding: 'utf8', cwd: root, timeout: 60_000,
  });
  const maintain = (...args) => spawnSync(process.execPath, [join(env.KITTO_HOME, 'runtime/bin/maintain.mjs'), ...args], {
    env, encoding: 'utf8', cwd: root, timeout: 60_000,
  });
  return {
    temp, bin, codexHome, source, env, run, stateFile, codexState, saveCodex, writeSource,
    calls, mcpCalls, state, plan, apply, git, initSource, cli, maintain,
  };
}

const good = result => assert.equal(result.status, 0, result.stdout + result.stderr);

test('source servers merge the platform overlay and skip credentials or unsupported fields', async t => {
  const f = fixture(t);
  writeFileSync(join(f.source, 'config/pi/mcp.json'), JSON.stringify({ mcpServers: {
    plain: { command: 'npx', args: ['-y', 'demo'] },
    http: { url: 'https://example.invalid/mcp' },
    withEnv: { command: 'node', args: ['server.mjs'], env: { TOKEN: '${TOKEN}' } },
    withHeaders: { url: 'https://example.invalid/headers', headers: { Authorization: 'Bearer x' } },
    withEnvHeaders: { url: 'https://example.invalid/env', env_http_headers: { 'X-Token': 'TOKEN' } },
    withTemplate: { command: '${BIN}', args: [] },
    withCwd: { command: 'node', args: [], cwd: '/tmp' },
    disabled: { command: 'off', args: [], enabled: false },
    _hidden: { command: 'hidden' },
    'bad name': { command: 'bad' },
  } }));
  mkdirSync(join(f.source, 'config/pi/platform/linux'), { recursive: true });
  writeFileSync(join(f.source, 'config/pi/platform/linux/mcp.json'), JSON.stringify({ mcpServers: {
    plain: { args: ['-y', 'demo@2'] },
    http: { enabled: false },
    platformOnly: { url: 'https://example.invalid/platform' },
  } }));
  const servers = await sourceServers(f.source, 'linux');
  const byName = new Map(servers.map(server => [server.name, server]));
  assert.deepEqual(byName.get('plain').transport, { type: 'stdio', command: 'npx', args: ['-y', 'demo@2'] });
  assert.equal(byName.get('plain').hash, transportHash(byName.get('plain').transport));
  assert.deepEqual(byName.get('platformOnly').transport, { type: 'http', url: 'https://example.invalid/platform' });
  assert.equal(byName.has('http'), false, 'platform disable is respected');
  assert.equal(byName.has('disabled'), false);
  assert.equal(byName.has('_hidden'), false);
  for (const name of ['withEnv', 'withHeaders', 'withEnvHeaders', 'withTemplate', 'withCwd']) {
    assert.match(byName.get(name).skip, /not synced in v1|credential template|not supported by codex mcp add/, name);
  }
  assert.match(byName.get('bad name').skip, /name contains characters/);
  assert.deepEqual(sourceTransport({ command: 'npx', args: [] }), { transport: { type: 'stdio', command: 'npx', args: [] } });
});

test('new source servers are added once and ownership fingerprints are recorded', async t => {
  const f = fixture(t);
  f.writeSource({
    alpha: { command: 'alpha-mcp', args: ['serve'] },
    remote: { url: 'https://example.invalid/mcp' },
  });
  const state = f.state();
  const first = await f.plan(state);
  assert.deepEqual(first.operations.map(operation => `${operation.action}:${operation.name}`).sort(),
    ['add:alpha', 'add:remote']);
  assert.match(first.lines.join('\n'), /mcp add: alpha \(codex\)/);
  await f.apply(state);
  assert.deepEqual(f.codexState().mcpServers.alpha.transport,
    { type: 'stdio', command: 'alpha-mcp', args: ['serve'] });
  assert.equal(f.codexState().mcpServers.remote.transport.url, 'https://example.invalid/mcp');
  assert.equal(state.mcp.codex.alpha, transportHash({ type: 'stdio', command: 'alpha-mcp', args: ['serve'] }));
  assert.equal(state.mcp.codex.remote, transportHash({ type: 'http', url: 'https://example.invalid/mcp' }));
  assert.deepEqual(f.mcpCalls('add').map(call => call.args.slice(2)),
    [['alpha', '--', 'alpha-mcp', 'serve'], ['remote', '--url', 'https://example.invalid/mcp']]);
  const saves = JSON.parse(readFileSync(join(f.temp, 'state.json'), 'utf8'));
  assert.equal(saves.mcp.codex.alpha, state.mcp.codex.alpha);

  const before = JSON.stringify(f.codexState().mcpServers);
  const second = await f.plan(state);
  assert.deepEqual(second.operations.map(operation => operation.action).sort(), ['same', 'same']);
  await f.apply(state);
  assert.equal(f.mcpCalls('add').length, 2, 'an idempotent sync must not add again');
  assert.equal(JSON.stringify(f.codexState().mcpServers), before);
});

test('a missing Codex home is treated as empty for preview and created only on apply', async t => {
  const f = fixture(t);
  rmSync(f.codexHome, { recursive: true, force: true });
  f.writeSource({ alpha: { command: 'alpha-mcp', args: [] } });
  const state = f.state();
  const preview = await f.plan(state);
  assert.deepEqual(preview.operations.map(operation => operation.action), ['add']);
  assert.equal(existsSync(f.codexHome), false, 'preview must not create CODEX_HOME');
  await f.apply(state);
  assert(existsSync(join(f.codexHome, '_fake-codex.json')));
  assert.equal(f.codexState().mcpServers.alpha.transport.command, 'alpha-mcp');
});

test('a same-name server without Kitto ownership is preserved with a warning', async t => {
  const f = fixture(t);
  f.saveCodex({ mcpServers: {
    alpha: { transport: { type: 'stdio', command: 'user-mcp', args: [] } },
  } });
  f.writeSource({ alpha: { command: 'kitto-mcp', args: [] } });
  const state = f.state();
  const { operations, lines } = await f.plan(state);
  assert.equal(operations.length, 1);
  assert.equal(operations[0].action, 'conflict');
  assert.match(operations[0].reason, /not owned by Kitto/);
  assert.match(lines.join('\n'), /preserved/);
  const { warnings } = await f.apply(state);
  assert.match(warnings.join('\n'), /preserved/);
  assert.equal(f.codexState().mcpServers.alpha.transport.command, 'user-mcp');
  assert.equal(f.mcpCalls('add').length, 0);
  assert.deepEqual(state.mcp.codex, {});
});

test('servers changed outside Kitto are preserved instead of overwritten', async t => {
  for (const mutation of ['transport', 'settings']) {
    const f = fixture(t);
    f.writeSource({ alpha: { command: 'kitto-mcp', args: ['serve'] } });
    const state = f.state();
    await f.apply(state);
    const data = f.codexState();
    if (mutation === 'transport') data.mcpServers.alpha.transport.command = 'user-mcp';
    else data.mcpServers.alpha.enabled_tools = ['read'];
    f.saveCodex(data);
    const liveBefore = JSON.stringify(f.codexState().mcpServers);
    const addCount = f.mcpCalls('add').length;
    const { operations } = await f.plan(state);
    assert.equal(operations[0].action, 'conflict');
    assert.match(operations[0].reason, /recorded ownership fingerprint|additional settings/);
    const { warnings } = await f.apply(state);
    assert.match(warnings.join('\n'), /preserved/);
    assert.equal(JSON.stringify(f.codexState().mcpServers), liveBefore);
    assert.equal(f.mcpCalls('add').length, addCount);
    assert.equal(state.mcp.codex.alpha, transportHash({ type: 'stdio', command: 'kitto-mcp', args: ['serve'] }));
  }
});

test('removing a source server only removes the untouched Kitto-owned live copy', async t => {
  const f = fixture(t);
  f.writeSource({
    alpha: { command: 'alpha-mcp', args: [] },
    beta: { command: 'beta-mcp', args: [] },
  });
  const state = f.state();
  await f.apply(state);
  const data = f.codexState();
  data.mcpServers.alpha.transport.command = 'edited-mcp';
  data.mcpServers.personal = { transport: { type: 'stdio', command: 'personal-mcp', args: [] } };
  f.saveCodex(data);
  f.writeSource({});
  const { operations } = await f.plan(state);
  const actions = new Map(operations.map(operation => [operation.name, operation.action]));
  assert.equal(actions.get('alpha'), 'conflict');
  assert.equal(actions.get('beta'), 'remove');
  assert.equal(actions.has('personal'), false);
  await f.apply(state);
  assert.equal(f.codexState().mcpServers.beta, undefined);
  assert.equal(f.codexState().mcpServers.alpha.transport.command, 'edited-mcp');
  assert(f.codexState().mcpServers.personal);
  assert.equal(state.mcp.codex.beta, undefined);
  assert.equal(state.mcp.codex.alpha, transportHash({ type: 'stdio', command: 'alpha-mcp', args: [] }));
  assert.deepEqual(f.mcpCalls('remove').map(call => call.args[2]), ['beta']);
});

test('a partial apply saves the successful server and resumes without repeating it', async t => {
  const f = fixture(t);
  f.writeSource({
    alpha: { command: 'alpha-mcp', args: [] },
    beta: { command: 'beta-mcp', args: [] },
  });
  const state = f.state();
  f.env.FAKE_MCP_FAIL_ADD = 'beta';
  await assert.rejects(f.apply(state), /simulated MCP add failure/);
  assert.equal(state.mcp.codex.alpha, transportHash({ type: 'stdio', command: 'alpha-mcp', args: [] }));
  assert.equal(state.mcp.codex.beta, undefined);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(f.temp, 'state.json'), 'utf8')).mcp.codex), ['alpha']);
  assert.deepEqual(Object.keys(f.codexState().mcpServers), ['alpha']);
  delete f.env.FAKE_MCP_FAIL_ADD;
  await f.apply(state);
  assert.deepEqual(Object.keys(f.codexState().mcpServers).sort(), ['alpha', 'beta']);
  assert.equal(state.mcp.codex.beta, transportHash({ type: 'stdio', command: 'beta-mcp', args: [] }));
  assert.equal(f.mcpCalls('add').filter(call => call.args[2] === 'alpha').length, 1);
  assert.equal(f.mcpCalls('add').filter(call => call.args[2] === 'beta').length, 2); // one failed attempt, one success
});

test('setup preview prints MCP actions without writing; apply owns only Kitto servers', t => {
  const f = fixture(t);
  f.saveCodex({ mcpServers: {
    personal: { transport: { type: 'stdio', command: 'personal-mcp', args: [] } },
  } });
  f.writeSource({
    alpha: { command: 'alpha-mcp', args: ['serve'] },
    personal: { command: 'kitto-personal', args: [] },
  });
  f.initSource();
  const preview = f.cli('setup', '--agents', 'codex', '--source', f.source, '--dry-run');
  good(preview);
  assert.match(preview.stdout, /mcp add: alpha \(codex\)/);
  assert.match(preview.stdout, /mcp conflict: personal \(codex\)/);
  assert.equal(existsSync(join(f.env.KITTO_HOME, 'state.json')), false);
  assert.equal(f.mcpCalls('add').length, 0);
  assert.equal(f.mcpCalls('remove').length, 0);

  const setup = f.cli('setup', '--agents', 'codex', '--source', f.source);
  good(setup);
  const state = JSON.parse(readFileSync(join(f.env.KITTO_HOME, 'state.json'), 'utf8'));
  assert.equal(state.mcp.codex.alpha, transportHash({ type: 'stdio', command: 'alpha-mcp', args: ['serve'] }));
  assert.equal(state.mcp.codex.personal, undefined);
  assert(f.codexState().mcpServers.alpha);
  assert.equal(f.codexState().mcpServers.personal.transport.command, 'personal-mcp');

  const before = JSON.stringify(f.codexState().mcpServers);
  const adds = f.mcpCalls('add').length;
  good(f.cli('setup'));
  assert.equal(JSON.stringify(f.codexState().mcpServers), before);
  assert.equal(f.mcpCalls('add').length, adds);

  const previewRemove = f.maintain('remove');
  good(previewRemove);
  assert.match(previewRemove.stdout, /mcp remove: alpha \(codex\)/);
  assert(f.codexState().mcpServers.alpha, 'preview must not remove MCP servers');
  good(f.maintain('remove', '--apply'));
  assert.equal(f.codexState().mcpServers.alpha, undefined);
  assert(f.codexState().mcpServers.personal);
  const detached = JSON.parse(readFileSync(join(f.env.KITTO_HOME, 'state.json'), 'utf8'));
  assert.equal(detached.detached, true);
  assert.deepEqual(detached.mcp.codex, {});
});

test('Codex setup fails with a clear error when the Pi MCP source is missing', t => {
  const f = fixture(t);
  writeFileSync(join(f.source, 'config/pi/AGENTS.md'), 'No MCP source here.');
  f.initSource();
  const result = f.cli('setup', '--agents', 'codex', '--source', f.source);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Codex MCP sync requires a readable Pi MCP source/);
  assert.match(result.stderr, /config\/pi\/mcp\.json/);
  assert.equal(existsSync(join(f.env.KITTO_HOME, 'state.json')), false);
});

test('removeCodexMcp reports ownership conflicts without deleting them', async t => {
  const f = fixture(t);
  f.writeSource({ alpha: { command: 'alpha-mcp', args: [] } });
  const state = f.state();
  await f.apply(state);
  const data = f.codexState();
  data.mcpServers.alpha.enabled_tools = ['read'];
  f.saveCodex(data);
  const preview = await removeCodexMcp(state, {
    run: f.run, env: f.env, home: f.codexHome, log: () => {}, warn: () => {},
  });
  assert.equal(preview.operations[0].action, 'conflict');
  assert(f.codexState().mcpServers.alpha);
  await removeCodexMcp(state, {
    apply: true, run: f.run, env: f.env, home: f.codexHome,
    save: async () => {}, log: () => {}, warn: () => {},
  });
  assert(f.codexState().mcpServers.alpha);
  assert.equal(state.mcp.codex.alpha, transportHash({ type: 'stdio', command: 'alpha-mcp', args: [] }));
});
