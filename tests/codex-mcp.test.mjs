import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyCodexMcp, defaultCodexRun, planCodexMcp, removeCodexMcp, sourceServers, sourceTransport, transportHash,
} from '../lib/codex-mcp.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const fakeAgent = join(root, 'tests/helpers/fake-agent.cjs');

function fixture(t) {
  const temp = mkdtempSync(join(tmpdir(), 'kitto-codex-mcp-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const bin = join(temp, 'bin'), codexHome = join(temp, 'codex'), source = join(temp, 'source');
  for (const dir of [bin, codexHome, join(source, 'config/pi')]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(bin, 'codex'), `#!${process.execPath}\nrequire(${JSON.stringify(fakeAgent)});\n`, { mode: 0o755 });
  const log = join(temp, 'calls.jsonl');
  const stateFile = join(codexHome, '_fake-codex.json');
  const env = {
    ...process.env, HOME: join(temp, 'home'), KITTO_HOME: join(temp, 'kitto'), CODEX_HOME: codexHome,
    FAKE_CODEX_STATE: stateFile, CALL_LOG: log, PATH: `${bin}:${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  };
  const run = (args, options = {}) => {
    const result = spawnSync('codex', args, { env, encoding: 'utf8', timeout: 15_000, ...options });
    if (result.error || result.status !== 0) {
      throw new Error(result.error?.message || result.stderr?.trim() || `codex exited ${result.status}`);
    }
    return result.stdout.trim();
  };
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
    withOauth: { url: 'https://example.invalid/oauth', oauth: { clientId: 'x' } },
    withTools: { command: 'node', args: [], tools: ['read'] },
    'dot.name': { command: 'dot-mcp', args: [] },
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
  for (const name of ['withEnv', 'withHeaders', 'withEnvHeaders', 'withTemplate', 'withCwd', 'withOauth', 'withTools']) {
    assert.match(byName.get(name).skip, /not synced in v1|credential template|not supported by codex mcp add/, name);
  }
  assert.deepEqual(byName.get('dot.name').transport, { type: 'stdio', command: 'dot-mcp', args: [] });
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

test('an owned server is updated when its source transport changes', async t => {
  const f = fixture(t);
  f.writeSource({ alpha: { command: 'alpha-mcp', args: ['serve'] } });
  const state = f.state();
  await f.apply(state);
  f.writeSource({ alpha: { command: 'alpha-v2-mcp', args: ['serve', '--new'] } });
  const { operations } = await f.plan(state);
  assert.equal(operations[0].action, 'update');
  await f.apply(state);
  assert.deepEqual(f.codexState().mcpServers.alpha.transport,
    { type: 'stdio', command: 'alpha-v2-mcp', args: ['serve', '--new'] });
  assert.equal(state.mcp.codex.alpha,
    transportHash({ type: 'stdio', command: 'alpha-v2-mcp', args: ['serve', '--new'] }));
  assert.equal(f.mcpCalls('add').length, 2);
  const again = await f.plan(state);
  assert.equal(again.operations[0].action, 'same');
});

test('an interrupted add leaves pending ownership that the next run adopts', async t => {
  const f = fixture(t);
  f.writeSource({ alpha: { command: 'alpha-mcp', args: ['serve'] } });
  const state = f.state(), statePath = join(f.temp, 'state.json');
  const hash = transportHash({ type: 'stdio', command: 'alpha-mcp', args: ['serve'] });
  let saves = 0;
  const save = async () => {
    saves++;
    if (saves === 2) throw new Error('simulated state write failure');
    writeFileSync(statePath, JSON.stringify(state));
  };
  await assert.rejects(applyCodexMcp(state, {
    run: f.run, env: f.env, home: f.codexHome, platform: 'linux', save, warn: () => {},
  }), /simulated state write failure/);
  assert(f.codexState().mcpServers.alpha);
  const interrupted = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(interrupted.mcp.codex.alpha, undefined);
  assert.equal(interrupted.mcp.codexPending.alpha, hash);
  const retry = JSON.parse(readFileSync(statePath, 'utf8'));
  const plan = await f.plan(retry);
  assert.equal(plan.operations[0].action, 'adopt');
  const adds = f.mcpCalls('add').length;
  await f.apply(retry);
  assert.equal(f.mcpCalls('add').length, adds, 'adoption must not add a second time');
  assert.equal(retry.mcp.codex.alpha, hash);
  assert.equal(retry.mcp.codexPending, undefined);
});

test('a verification failure after the native write is adopted on retry', async t => {
  const f = fixture(t);
  f.writeSource({ alpha: { command: 'alpha-mcp', args: ['serve'] } });
  const state = f.state(), statePath = join(f.temp, 'state.json'), hash = transportHash({
    type: 'stdio', command: 'alpha-mcp', args: ['serve'],
  });
  let failNextList = false;
  const run = (args, options = {}) => {
    if (args[0] === 'mcp' && args[1] === 'add') {
      const output = f.run(args, options);
      failNextList = true;
      return output;
    }
    if (failNextList && args[0] === 'mcp' && args[1] === 'list') {
      failNextList = false;
      throw new Error('simulated list failure');
    }
    return f.run(args, options);
  };
  const save = async () => writeFileSync(statePath, JSON.stringify(state));
  await assert.rejects(applyCodexMcp(state, {
    run, env: f.env, home: f.codexHome, platform: 'linux', save, warn: () => {},
  }), /simulated list failure/);
  const interrupted = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(interrupted.mcp.codex.alpha, undefined);
  assert.equal(interrupted.mcp.codexPending.alpha, hash);
  const retry = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal((await f.plan(retry)).operations[0].action, 'adopt');
  await f.apply(retry);
  assert.equal(retry.mcp.codex.alpha, hash);
  assert.equal(retry.mcp.codexPending, undefined);
});

test('pending-only servers are reconciled when the source disappears', async t => {
  const f = fixture(t);
  f.writeSource({ alpha: { command: 'alpha-mcp', args: [] } });
  const state = f.state(), statePath = join(f.temp, 'state.json');
  let saves = 0;
  const save = async () => {
    saves++;
    if (saves === 2) throw new Error('simulated state write failure');
    writeFileSync(statePath, JSON.stringify(state));
  };
  await assert.rejects(applyCodexMcp(state, {
    run: f.run, env: f.env, home: f.codexHome, platform: 'linux', save, warn: () => {},
  }), /simulated state write failure/);
  const interrupted = JSON.parse(readFileSync(statePath, 'utf8'));
  assert(interrupted.mcp.codexPending.alpha);
  f.writeSource({});
  const plan = await f.plan(interrupted);
  assert(plan.operations.some(operation => operation.action === 'remove' && operation.name === 'alpha'));
  await f.apply(interrupted);
  assert.equal(f.codexState().mcpServers.alpha, undefined);
  assert.equal(interrupted.mcp.codexPending, undefined);
  assert.deepEqual(interrupted.mcp.codex, {});
  const orphan = f.state();
  orphan.mcp.codexPending = { beta: transportHash({ type: 'stdio', command: 'beta-mcp', args: [] }) };
  f.saveCodex({ mcpServers: {} });
  const orphanPlan = await f.plan(orphan);
  assert.equal(orphanPlan.operations[0].action, 'forgetPending');
  await f.apply(orphan);
  assert.equal(orphan.mcp.codexPending, undefined);
  const changed = f.state();
  changed.mcp.codexPending = { gamma: transportHash({ type: 'stdio', command: 'gamma-mcp', args: [] }) };
  f.saveCodex({ mcpServers: { gamma: { transport: { type: 'stdio', command: 'user-gamma', args: [] } } } });
  const changedPlan = await f.plan(changed);
  assert.equal(changedPlan.operations[0].action, 'forgetPending');
  await f.apply(changed);
  assert.equal(f.codexState().mcpServers.gamma.transport.command, 'user-gamma');
  assert.equal(changed.mcp.codexPending, undefined);
});

test('a native add timeout after writing the server is adopted with a warning', async t => {
  const f = fixture(t);
  f.writeSource({ remote: { url: 'https://example.invalid/mcp' } });
  const state = f.state(), statePath = join(f.temp, 'state.json');
  const warnings = [];
  const run = (args, options = {}) => {
    if (args[0] === 'mcp' && args[1] === 'add') {
      f.run(args, options);
      throw new Error(`codex mcp add ${args[2]} timed out after 30000ms`);
    }
    return f.run(args, options);
  };
  await applyCodexMcp(state, {
    run, env: f.env, home: f.codexHome, platform: 'linux',
    save: async () => writeFileSync(statePath, JSON.stringify(state)),
    warn: line => warnings.push(line),
  });
  assert.equal(f.codexState().mcpServers.remote.transport.url, 'https://example.invalid/mcp');
  assert.equal(state.mcp.codex.remote, transportHash({ type: 'http', url: 'https://example.invalid/mcp' }));
  assert.equal(state.mcp.codexPending, undefined);
  assert.match(warnings.join('\n'), /adopted/);
  assert.match(warnings.join('\n'), /codex mcp login remote/);
  assert.equal(f.mcpCalls('add').length, 1);
});

test('a native add timeout without a live server is retried, not adopted', async t => {
  const f = fixture(t);
  f.writeSource({ remote: { url: 'https://example.invalid/mcp' } });
  const state = f.state(), statePath = join(f.temp, 'state.json');
  const run = (args, options = {}) => {
    if (args[0] === 'mcp' && args[1] === 'add') throw new Error('codex mcp add timed out');
    return f.run(args, options);
  };
  await assert.rejects(applyCodexMcp(state, {
    run, env: f.env, home: f.codexHome, platform: 'linux',
    save: async () => writeFileSync(statePath, JSON.stringify(state)), warn: () => {},
  }), /timed out/);
  assert.equal(f.codexState().mcpServers.remote, undefined);
  assert.equal(state.mcp.codex.remote, undefined);
  assert(state.mcp.codexPending.remote);
});

test('a post-write timeout does not adopt a different live transport', async t => {
  const f = fixture(t);
  f.writeSource({ remote: { url: 'https://target.example/mcp' } });
  const state = f.state(), statePath = join(f.temp, 'state.json');
  const run = (args, options = {}) => {
    if (args[0] === 'mcp' && args[1] === 'add') {
      const altered = [...args];
      altered[altered.length - 1] = 'https://user.example/mcp';
      f.run(altered, options);
      throw new Error('simulated timeout after writing a different server');
    }
    return f.run(args, options);
  };
  await assert.rejects(applyCodexMcp(state, {
    run, env: f.env, home: f.codexHome, platform: 'linux',
    save: async () => writeFileSync(statePath, JSON.stringify(state)), warn: () => {},
  }), /simulated timeout/);
  assert.equal(f.codexState().mcpServers.remote.transport.url, 'https://user.example/mcp');
  assert.equal(state.mcp.codex.remote, undefined);
  assert(state.mcp.codexPending.remote, 'the pending record stays for a safe retry');
  const plan = await f.plan(state);
  assert.equal(plan.operations[0].action, 'conflict');
  await f.apply(state);
  assert.equal(f.codexState().mcpServers.remote.transport.url, 'https://user.example/mcp');
  assert.equal(state.mcp.codexPending, undefined);
});

test('a failed pre-write save never touches live Codex', async t => {
  const f = fixture(t);
  f.writeSource({ alpha: { command: 'alpha-mcp', args: [] } });
  const state = f.state();
  const save = async () => { throw new Error('simulated disk full'); };
  await assert.rejects(applyCodexMcp(state, {
    run: f.run, env: f.env, home: f.codexHome, platform: 'linux', save, warn: () => {},
  }), /simulated disk full/);
  assert.equal(f.mcpCalls('add').length, 0);
  assert.deepEqual(f.codexState().mcpServers, {});
});

test('verified missing live servers prune stale ownership instead of misclaiming a user server', async t => {
  const f = fixture(t);
  f.writeSource({ alpha: { command: 'alpha-mcp', args: [] } });
  const state = f.state();
  await f.apply(state);
  const data = f.codexState();
  delete data.mcpServers.alpha;
  f.saveCodex(data);
  let plan = await f.plan(state);
  assert.equal(plan.operations[0].action, 'add', 'a live deletion is restored rather than reported as a conflict');
  f.writeSource({});
  plan = await f.plan(state);
  assert.equal(plan.operations[0].action, 'forget');
  await f.apply(state);
  assert.deepEqual(state.mcp.codex, {});
  f.writeSource({ alpha: { command: 'alpha-mcp', args: [] } });
  f.saveCodex({ mcpServers: { alpha: { transport: { type: 'stdio', command: 'alpha-mcp', args: [] } } } });
  plan = await f.plan(state);
  assert.equal(plan.operations[0].action, 'conflict');
  await f.apply(state);
  assert(f.codexState().mcpServers.alpha);
  assert.deepEqual(state.mcp.codex, {});
});

test('dotted server names are synced with the name set Codex accepts', async t => {
  const f = fixture(t);
  f.writeSource({ 'dot.name': { command: 'dot-mcp', args: [] } });
  const state = f.state();
  const { operations } = await f.plan(state);
  assert.equal(operations[0].action, 'add');
  await f.apply(state);
  assert.equal(f.codexState().mcpServers['dot.name'].transport.command, 'dot-mcp');
  assert.equal(state.mcp.codex['dot.name'], transportHash({ type: 'stdio', command: 'dot-mcp', args: [] }));
});

test('preview probes a scratch CODEX_HOME instead of writing the real one', async t => {
  const f = fixture(t);
  f.writeSource({ alpha: { command: 'alpha-mcp', args: [] } });
  writeFileSync(join(f.codexHome, 'config.toml'), '[mcp_servers.alpha]\ncommand = "alpha-mcp"\n');
  const seen = [];
  const run = (args, options = {}) => {
    seen.push(options.env?.CODEX_HOME);
    if (args[1] === 'list') return JSON.stringify([]);
    throw new Error(`unexpected fake command: ${args.join(' ')}`);
  };
  const operations = await planCodexMcp(f.state(), {
    run, env: { ...f.env }, home: f.codexHome, platform: 'linux', log: () => {},
  });
  assert.equal(operations[0].action, 'add');
  assert(seen.length > 0);
  for (const home of seen) {
    assert.notEqual(home, f.codexHome);
    assert(home.startsWith(tmpdir()));
  }
  assert.equal(existsSync(seen[0]), false, 'the scratch home is removed after the probe');
  assert.deepEqual(readdirSync(f.codexHome), ['config.toml']);
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
  assert.equal(f.mcpCalls('add').filter(call => call.args[2] === 'beta').length, 2);
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

test('setup preview and status never invoke Codex with the real CODEX_HOME', t => {
  const f = fixture(t);
  f.writeSource({ alpha: { command: 'alpha-mcp', args: [] } });
  f.initSource();
  const marker = join(f.codexHome, 'invocations.log');
  writeFileSync(join(f.bin, 'codex'), `#!${process.execPath}\n` +
    `const fs = require('node:fs'), path = require('node:path');\n` +
    `if (process.env.CODEX_HOME) { fs.mkdirSync(process.env.CODEX_HOME, { recursive: true }); ` +
    `fs.appendFileSync(path.join(process.env.CODEX_HOME, 'invocations.log'), 'x'); }\n` +
    `require(${JSON.stringify(fakeAgent)});\n`, { mode: 0o755 });
  const preview = f.cli('setup', '--agents', 'codex', '--source', f.source, '--dry-run');
  good(preview);
  assert.equal(existsSync(marker), false, 'dry-run must use scratch CODEX_HOME probes');
  good(f.cli('setup', '--agents', 'codex', '--source', f.source));
  assert(existsSync(marker), 'setup apply registers native integrations with the real home');
  rmSync(marker, { force: true });
  good(f.maintain('status'));
  assert.equal(existsSync(marker), false, 'status must use scratch CODEX_HOME probes');
});

test('an HTTP Authorization reference becomes --bearer-token-env-var', async t => {
  const f = fixture(t);
  f.writeSource({ api: { url: 'https://example.invalid/mcp', headers: { Authorization: 'Bearer ${API_TOKEN}' } } });
  const state = f.state();
  const { operations } = await f.plan(state);
  assert.deepEqual(operations.map(operation => `${operation.action}:${operation.name}`), ['add:api']);
  assert.deepEqual(operations[0].transport,
    { type: 'http', url: 'https://example.invalid/mcp', bearerTokenEnvVar: 'API_TOKEN' });

  await f.apply(state);
  assert.deepEqual(f.codexState().mcpServers.api.transport,
    { type: 'streamable_http', url: 'https://example.invalid/mcp', bearer_token_env_var: 'API_TOKEN' });
  assert.deepEqual(f.mcpCalls('add')[0].args,
    ['mcp', 'add', 'api', '--url', 'https://example.invalid/mcp', '--bearer-token-env-var', 'API_TOKEN']);
  assert.equal(state.mcp.codex.api, transportHash(
    { type: 'http', url: 'https://example.invalid/mcp', bearerTokenEnvVar: 'API_TOKEN' }));
  assert(!JSON.stringify(f.calls()).includes('Bearer'), 'the source scheme is not copied into argv');
  assert(!JSON.stringify(f.codexState()).includes('Bearer'));

  const { operations: again } = await f.plan(state);
  assert.equal(again[0].action, 'same');
  await f.apply(state);
  assert.equal(f.mcpCalls('add').length, 1);
});

test('headers and stdio env Codex cannot express are skipped with a warning', async t => {
  const f = fixture(t);
  f.writeSource({
    otherHeader: { url: 'https://example.invalid/other', headers: { 'X-Api-Key': '${API_KEY}' } },
    bearerWithoutScheme: { url: 'https://example.invalid/bare', headers: { Authorization: '${AUTH}' } },
    stdioEnv: { command: 'node', env: { TOKEN: '${TOKEN}' } },
    stdioHeaders: { command: 'node', headers: { Authorization: 'Bearer ${TOKEN}' } },
  });
  const state = f.state();
  const { operations, lines } = await f.plan(state);
  assert(operations.every(operation => operation.action === 'skip'));
  assert.match(operations.find(operation => operation.name === 'otherHeader').reason,
    /headers are not synced in v1: only Authorization: Bearer \$\{VAR\}/);
  assert.match(operations.find(operation => operation.name === 'stdioEnv').reason,
    /env is not synced in v1: codex mcp add --env would store a literal/);
  assert.match(lines.join('\n'), /mcp skip: otherHeader \(codex\)/);

  const { warnings } = await f.apply(state);
  assert.match(warnings.join('\n'), /mcp skip: stdioEnv \(codex\)/);
  assert.deepEqual(f.mcpCalls('add'), []);
  assert.deepEqual(f.codexState().mcpServers, {});
});

test('a literal secret anywhere in a source server is refused without being printed', async t => {
  const f = fixture(t);
  const token = `ghp_${'c'.repeat(30)}`;
  f.writeSource({
    plain: { command: 'plain-mcp' },
    leaky: { command: 'npx', args: [`--token=${token}`] },
  });
  const state = f.state();
  const { operations } = await f.plan(state);
  const leaky = operations.find(operation => operation.name === 'leaky');
  assert.equal(leaky.action, 'skip');
  assert.match(leaky.reason, /contains a literal secret \(GitHub token\) at args\[0\]/);
  assert(!JSON.stringify(operations).includes(token));
  await f.apply(state);
  assert.equal(f.codexState().mcpServers.leaky, undefined);
  assert(f.codexState().mcpServers.plain);
  assert(!f.mcpCalls('add').some(call => call.args[2] === 'leaky'));
});

test('private and local self-hosted servers are opt-in for Codex', async t => {
  const f = fixture(t);
  f.writeSource({ plain: { command: 'plain-mcp' } });
  writeFileSync(join(f.source, 'config/pi/mcp.private.json'), JSON.stringify({ mcpServers: {
    privateApi: { url: 'https://private.invalid/mcp', headers: { Authorization: 'Bearer ${PRIVATE_TOKEN}' } },
  } }));
  mkdirSync(join(f.source, 'config/pi/local'), { recursive: true });
  writeFileSync(join(f.source, 'config/pi/local/mcp.json'), JSON.stringify({ mcpServers: {
    localServer: { command: 'local-mcp' },
  } }));
  const state = f.state();

  let { operations } = await f.plan(state);
  assert.deepEqual(operations.map(operation => `${operation.action}:${operation.name}`), ['add:plain']);

  state.includePrivate = true;
  ({ operations } = await f.plan(state));
  assert.deepEqual(operations.map(operation => `${operation.action}:${operation.name}`).sort(),
    ['add:localServer', 'add:plain', 'add:privateApi']);
  await f.apply(state);
  assert(f.codexState().mcpServers.privateApi.transport.bearer_token_env_var === 'PRIVATE_TOKEN');
  assert(f.codexState().mcpServers.localServer);

  state.includePrivate = false;
  ({ operations } = await f.plan(state));
  assert.deepEqual(operations.map(operation => `${operation.action}:${operation.name}`).sort(),
    ['remove:localServer', 'remove:privateApi', 'same:plain']);
  await f.apply(state);
  assert.deepEqual(Object.keys(f.codexState().mcpServers).sort(), ['plain']);
});

test('setup --include-private persists the opt-in and --no-include-private removes it', t => {
  const f = fixture(t);
  f.writeSource({ plain: { command: 'plain-mcp' } });
  writeFileSync(join(f.source, 'config/pi/mcp.private.json'), JSON.stringify({ mcpServers: {
    privateApi: { url: 'https://private.invalid/mcp', headers: { Authorization: 'Bearer ${PRIVATE_TOKEN}' } },
  } }));
  f.initSource();
  const state = () => JSON.parse(readFileSync(join(f.env.KITTO_HOME, 'state.json'), 'utf8'));

  good(f.cli('setup', '--agents', 'codex', '--source', f.source, '--include-private'));
  assert.equal(state().includePrivate, true);
  assert(f.codexState().mcpServers.privateApi);

  good(f.cli('setup'));
  assert.equal(state().includePrivate, true, 'a later setup keeps the saved opt-in');
  assert(f.codexState().mcpServers.privateApi);

  good(f.cli('setup', '--no-include-private'));
  assert.equal(state().includePrivate, false);
  assert.equal(f.codexState().mcpServers.privateApi, undefined);
  assert(f.codexState().mcpServers.plain);
});

test('literal URL and command credentials are refused before argv', async t => {
  const f = fixture(t);
  f.writeSource({
    userinfo: { url: 'https://user:pass@example.invalid/mcp' },
    query: { url: 'https://example.invalid/mcp?access_token=abcd' },
    flag: { command: 'npx', args: ['--api-key', 'abcd'] },
    assign: { command: 'npx', args: ['TOKEN=abcd'] },
    header: { command: 'npx', args: ['--header', 'Authorization: Bearer abcd'] },
    sigQuery: { url: 'https://example.invalid/mcp?sig=abcd' },
    authQuery: { url: 'https://example.invalid/mcp?auth=abcd' },
    apikeyQuery: { url: 'https://example.invalid/mcp?apikey=abcd' },
    headerSeparate: { command: 'npx', args: ['-H', 'X-Key: abcd'] },
    headerInline: { command: 'npx', args: ['--header=X-Key: abcd'] },
    headerSafe: { command: 'npx', args: ['-H', 'Accept: application/json'] },
    flagToken: { command: 'npx', args: ['--token', 'abcd'] },
    safe: { url: 'https://example.invalid/mcp?tenant=acme' },
  });
  const state = f.state();
  const { operations } = await f.plan(state);
  const byName = new Map(operations.map(operation => [operation.name, operation]));
  for (const [name, reason] of [
    ['userinfo', /url contains userinfo credentials/],
    ['query', /url has a credential-like query parameter/],
    ['flag', /args\[1\] looks like a literal credential/],
    ['assign', /args\[0\] looks like a literal credential/],
    ['header', /args\[1\] looks like a sensitive header/],
    ['sigQuery', /url has a credential-like query parameter/],
    ['authQuery', /url has a credential-like query parameter/],
    ['apikeyQuery', /url has a credential-like query parameter/],
    ['headerSeparate', /args\[1\] looks like a sensitive header/],
    ['headerInline', /args\[0\] looks like a sensitive header/],
    ['flagToken', /args\[1\] looks like a literal credential/],
  ]) {
    assert.equal(byName.get(name).action, 'skip', name);
    assert.match(byName.get(name).reason, reason, name);
  }
  assert.equal(byName.get('safe').action, 'add');
  assert.equal(byName.get('headerSafe').action, 'add');
  assert(!JSON.stringify(operations).includes('user:pass'));
  assert(!JSON.stringify(operations).includes('abcd'));

  await f.apply(state);
  assert.deepEqual(f.mcpCalls('add').map(call => call.args[2]), ['headerSafe', 'safe']);
  assert(f.mcpCalls('add').some(call => call.args.includes('https://example.invalid/mcp?tenant=acme')));
  assert(!JSON.stringify(f.calls()).includes('user:pass'));
  assert(!JSON.stringify(f.calls()).includes('abcd'));
});

test('native Codex failures never echo argv', async t => {
  const temp = mkdtempSync(join(tmpdir(), 'kitto-codex-failure-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const bin = join(temp, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'codex'), `#!${process.execPath}\nprocess.exit(9)\n`, { mode: 0o755 });
  const env = { ...process.env, HOME: temp, CODEX_HOME: join(temp, 'codex'), PATH: `${bin}:${process.env.PATH}` };
  assert.throws(() => defaultCodexRun(
    ['mcp', 'add', 'secret-server-name', '--url', 'https://user:pass@example.invalid/mcp'], { env },
  ), error => {
    assert.match(error.message, /codex mcp add failed/);
    assert.doesNotMatch(error.message, /secret-server-name|user:pass/);
    return true;
  });
});
