import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexMcpNames } from '../lib/parity.ts';
import { get, list } from '../lib/ownership.ts';

const root = process.env.KITTO_TEST_PACKAGE_ROOT ? resolve(process.env.KITTO_TEST_PACKAGE_ROOT) : fileURLToPath(new URL('../dist/', import.meta.url));
const nativeBin = process.env.KITTO_NATIVE_BIN;
test('native Pi/Codex/DSH installation, version change, recovery, detach and reinstall', { skip: !nativeBin, timeout: 240_000 }, t => {
  const temp = mkdtempSync(join(tmpdir(), "kitto native's "));
  t.onTestFinished(() => rmSync(temp, { recursive: true, force: true }));
  const home = join(temp, 'home'), source = join(temp, 'config'), previous = join(temp, 'previous');
  for (const dir of [home, previous, join(source, 'config/pi'), join(source, 'config/instructions'), join(source, 'skills/example')]) mkdirSync(dir, { recursive: true });
  const env = { ...process.env, HOME: home, KITTO_HOME: join(home, 'kitto'),
    PI_CODING_AGENT_DIR: join(home, 'pi'), PI_AGENTS_DIR: join(home, '.agents'), CODEX_HOME: join(home, 'codex'),
    DSH_HOME: join(home, 'dsh'), DSH_AGENTS_HOME: join(home, '.agents'), KITTO_UPDATE_CHECK: '0',
    PATH: `${resolve(nativeBin)}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const run = (command, args) => execFileSync(command, args, { env, cwd: home, encoding: 'utf8', timeout: 90_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const json = path => JSON.parse(readFileSync(path, 'utf8'));
  const state = () => json(join(env.KITTO_HOME, 'state.json'));
  const cli = (directory, ...args) => run(process.execPath, [join(directory, 'bin/kitto.mjs'), 'setup', ...args]);
  const maintain = (...args) => run(process.execPath, [join(env.KITTO_HOME, 'runtime/bin/maintain.mjs'), ...args]);
  const kittoMcp = {
    'shared-fixture': { command: 'kitto-shared-mcp', args: ['serve', '--shared'] },
    'kitto-fixture': { command: 'kitto-fixture-mcp', args: ['serve'] },
  };
  const files = {
    '.gitignore': 'config/pi/local/\n',
    'config/pi/settings.json': '{"packages":[],"quietStartup":true}',
    'config/instructions/common.md': '# Shared native fixture rules\n',
    'config/pi/mcp.json': JSON.stringify({ mcpServers: kittoMcp }), 'config/pi/AGENTS.md': 'Personal configuration fixture.',
    'config/pi/i-have-adhd-always': '', 'config/env.example': '# no credentials\n',
    'skills/example/SKILL.md': '---\nname: example\ndescription: A personal example task.\n---\nPreserve this personal skill.\n',
  };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(source, name), text);
  for (const args of [['init', '-b', 'main'], ['config', 'user.email', 'test@example.invalid'], ['config', 'user.name', 'Kitto test'], ['add', '.'], ['commit', '-m', 'fixture']]) run('git', ['-C', source, ...args]);
  const sourceHead = run('git', ['-C', source, 'rev-parse', 'HEAD']);
  for (const name of ['package.json', 'bin', 'lib', 'integration', 'CHANGELOG.md']) {
    cpSync(join(root, name), join(previous, name), { recursive: true, filter: path => !path.includes('__pycache__') });
  }
  for (const name of ['package.json', 'integration/plugin.json']) {
    const data = json(join(previous, name)); data.version = '0.0.0-native.1';
    writeFileSync(join(previous, name), JSON.stringify(data));
  }
  const pluginVersion = () => JSON.parse(run('codex', ['plugin', 'list', '--json'])).installed.find(x => x.pluginId === 'kitto@phyzess-kitto')?.version;
  const profile = 'headless';
  const dshProfile = () => json(join(env.DSH_HOME, 'profiles', profile, 'package.json'));
  const piPackages = () => json(join(env.PI_CODING_AGENT_DIR, 'settings.json')).packages || [];
  const ownedPi = () => piPackages().filter(entry => {
    const value = typeof entry === 'string' ? entry : entry.source;
    return resolve(env.PI_CODING_AGENT_DIR, value) === join(env.KITTO_HOME, 'runtime');
  });
  const codexConfig = join(env.CODEX_HOME, 'config.toml');
  const codexConfigHash = () => createHash('sha256').update(readFileSync(codexConfig, 'utf8')).digest('hex');
  const codexServers = () => JSON.parse(run('codex', ['mcp', 'list', '--json']));
  const codexNames = () => codexServers().map(server => server.name).sort();
  const codexServer = name => codexServers().find(server => server.name === name);
  mkdirSync(env.CODEX_HOME, { recursive: true });
  run('codex', ['mcp', 'add', 'shared-fixture', '--', 'user-shared-mcp']);
  assert.deepEqual(codexNames(), ['shared-fixture']);
  cli(previous, '--agents', 'pi,codex,dsh', '--source', source, '--dsh-profile', profile);
  assert.equal(pluginVersion(), '0.0.0-native.1');
  assert.deepEqual(codexNames(), ['kitto-fixture', 'shared-fixture']);
  assert.equal(codexServer('shared-fixture').transport.command, 'user-shared-mcp');
  assert.equal(codexServer('kitto-fixture').transport.command, 'kitto-fixture-mcp');
  assert.equal(get(state(), 'mcp', 'codex', 'shared-fixture'), undefined);
  assert.match(get(state(), 'mcp', 'codex', 'kitto-fixture').hash, /^[0-9a-f]{64}$/);
  const configHashAfterSetup = codexConfigHash();
  maintain('sync', '--apply');
  assert.equal(codexConfigHash(), configHashAfterSetup);
  assert.deepEqual(codexNames(), ['kitto-fixture', 'shared-fixture']);
  assert.equal(codexServer('shared-fixture').transport.command, 'user-shared-mcp');
  writeFileSync(join(source, 'config/pi/mcp.json'), JSON.stringify({ mcpServers: {
    ...kittoMcp,
    'kitto-fixture': { command: 'kitto-fixture-mcp', args: ['serve', '--updated'] },
  } }));
  maintain('sync', '--apply');
  assert.deepEqual(codexServer('kitto-fixture').transport.args, ['serve', '--updated']);
  assert.equal(codexServer('shared-fixture').transport.command, 'user-shared-mcp');
  const patch = join(env.DSH_HOME, 'profiles', profile, 'cordis.patch.yml');
  const originalPatch = existsSync(patch) ? readFileSync(patch, 'utf8') : '[]\n';
  writeFileSync(patch, originalPatch + '\n# personal override marker\n');
  const patchBefore = readFileSync(patch, 'utf8');
  const nativeVersion = json(join(root, 'package.json')).version;
  cli(root);
  assert.equal(pluginVersion(), nativeVersion);
  assert.equal(state().version, nativeVersion);
  assert.equal(state().dshProfile, profile);
  assert(!existsSync(join(env.DSH_HOME, 'profiles/web')));
  assert.equal(ownedPi().length, 1);
  assert.equal(dshProfile().dsh.profile.bundles.filter(x => x === '@phyzess/kitto').length, 1);
  assert.equal(readFileSync(patch, 'utf8'), patchBefore);
  assert.match(run('dsh', [profile, '--dump-config']), /phyzess-kitto/);
  cli(root, '--recover');
  assert.equal(pluginVersion(), '0.0.0-native.1');
  assert.equal(state().version, '0.0.0-native.1');
  assert.equal(ownedPi().length, 1);
  cli(root);
  const configHashBeforeRemove = codexConfigHash();
  const preview = maintain('remove');
  assert.match(preview, /Keep configuration/);
  assert.match(preview, /mcp remove: kitto-fixture \(codex\)/);
  assert.equal(codexConfigHash(), configHashBeforeRemove);
  assert.equal(pluginVersion(), nativeVersion);
  maintain('remove', '--apply'); maintain('remove', '--apply');
  assert.equal(state().detached, true);
  assert.deepEqual(codexNames(), ['shared-fixture']);
  assert.equal(codexServer('shared-fixture').transport.command, 'user-shared-mcp');
  assert.deepEqual(list(state(), 'mcp', 'codex'), []);
  assert.equal(ownedPi().length, 0);
  assert.equal(pluginVersion(), undefined);
  assert(!JSON.parse(run('codex', ['plugin', 'marketplace', 'list', '--json'])).marketplaces.some(x => x.name === 'phyzess-kitto'));
  assert(!dshProfile().dependencies?.['@phyzess/kitto']);
  assert(!dshProfile().dsh.profile.bundles.includes('@phyzess/kitto'));
  assert.doesNotMatch(run('dsh', [profile, '--dump-config']), /phyzess-kitto/);
  assert.equal(readFileSync(patch, 'utf8'), patchBefore);
  assert.equal(run('git', ['-C', source, 'rev-parse', 'HEAD']), sourceHead);
  assert.equal(readFileSync(join(env.PI_AGENTS_DIR, 'skills/example/SKILL.md'), 'utf8'), files['skills/example/SKILL.md']);
  cli(root);
  assert.equal(pluginVersion(), nativeVersion);
  assert.equal(state().ready, true);
  assert.equal(ownedPi().length, 1);
  assert.deepEqual(codexNames(), ['kitto-fixture', 'shared-fixture']);
  assert.equal(codexServer('shared-fixture').transport.command, 'user-shared-mcp');
  assert.deepEqual(codexServer('kitto-fixture').transport.args, ['serve', '--updated']);
  assert.match(get(state(), 'mcp', 'codex', 'kitto-fixture').hash, /^[0-9a-f]{64}$/);
  assert(dshProfile().dsh.profile.bundles.includes('@phyzess/kitto'));
});

test('native hosts load and remove reference-only MCP credentials', { skip: !nativeBin, timeout: 240_000 }, t => {
  const temp = mkdtempSync(join(tmpdir(), "kitto native creds's "));
  t.onTestFinished(() => rmSync(temp, { recursive: true, force: true }));
  const home = join(temp, 'home'), source = join(temp, 'config');
  for (const dir of [home, join(source, 'config/pi'), join(source, 'config/instructions'), join(source, 'skills/example')]) mkdirSync(dir, { recursive: true });
  const env = { ...process.env, HOME: home, KITTO_HOME: join(home, 'kitto'),
    PI_CODING_AGENT_DIR: join(home, 'pi'), PI_AGENTS_DIR: join(home, '.agents'), CODEX_HOME: join(home, 'codex'),
    DSH_HOME: join(home, 'dsh'), DSH_AGENTS_HOME: join(home, '.agents'), KITTO_UPDATE_CHECK: '0',
    KITTO_TEST_TOKEN: 'native-fixture-token',
    PATH: `${resolve(nativeBin)}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const run = (command, args) => execFileSync(command, args, { env, cwd: home, encoding: 'utf8', timeout: 90_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const cli = (...args) => run(process.execPath, [join(root, 'bin/kitto.mjs'), 'setup', ...args]);
  const maintain = (...args) => run(process.execPath, [join(env.KITTO_HOME, 'runtime/bin/maintain.mjs'), ...args]);
  const codexServers = () => JSON.parse(run('codex', ['mcp', 'list', '--json']));
  const files = {
    '.gitignore': 'config/pi/local/\n',
    'config/pi/settings.json': '{"packages":[],"quietStartup":true}',
    'config/instructions/common.md': '# Shared native fixture rules\n',
    'config/pi/mcp.json': JSON.stringify({ mcpServers: {
      'plain-fixture': { command: 'kitto-plain-mcp', args: ['serve'] },
      'dsh-env-fixture': { command: 'kitto-env-mcp', env: { FIXTURE_TOKEN: '${KITTO_TEST_TOKEN}' } },
      'dsh-cred-fixture': { type: 'http', url: 'http://127.0.0.1:9/mcp',
        headers: { Authorization: 'Bearer ${KITTO_TEST_TOKEN}' } },
    } }),
    'config/pi/AGENTS.md': 'Native credential fixture.',
    'config/pi/i-have-adhd-always': '', 'config/env.example': '# no credentials\n',
    'skills/example/SKILL.md': '---\nname: example\ndescription: Native credential fixture.\n---\nPreserve this.\n',
  };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(source, name), text);
  for (const args of [['init', '-b', 'main'], ['config', 'user.email', 'test@example.invalid'],
    ['config', 'user.name', 'Kitto test'], ['add', '.'], ['commit', '-m', 'fixture']]) run('git', ['-C', source, ...args]);

  cli('--agents', 'codex,dsh', '--source', source);

  const codexCred = JSON.parse(run('codex', ['mcp', 'get', 'dsh-cred-fixture', '--json']));
  assert.equal(codexCred.transport.bearer_token_env_var, 'KITTO_TEST_TOKEN');
  assert.deepEqual(codexServers().map(server => server.name).sort(), ['dsh-cred-fixture', 'plain-fixture']);
  const codexConfig = readFileSync(join(env.CODEX_HOME, 'config.toml'), 'utf8');
  assert.match(codexConfig, /bearer_token_env_var = "KITTO_TEST_TOKEN"/);
  assert.doesNotMatch(codexConfig, /native-fixture-token/);

  const patch = readFileSync(join(env.DSH_HOME, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /\$\{credential:KITTO_TEST_TOKEN\}/);
  assert.match(patch, /expandTemplates: true/);
  assert.doesNotMatch(patch, /native-fixture-token/);
  const dump = run('dsh', ['web', '--dump-config']);
  for (const name of ['plain-fixture', 'dsh-env-fixture', 'dsh-cred-fixture']) {
    assert.match(dump, new RegExp(`id: kitto-mcp-${name}`), name);
  }
  assert.match(dump, /expandTemplates: true/);
  assert.match(dump, /\$\{credential:KITTO_TEST_TOKEN\}/);
  assert.doesNotMatch(dump, /native-fixture-token/);

  maintain('remove', '--apply');
  assert.deepEqual(codexServers(), []);
  const dumpAfter = run('dsh', ['web', '--dump-config']);
  assert.doesNotMatch(dumpAfter, /kitto-mcp-|credential:KITTO_TEST_TOKEN/);
  assert.doesNotMatch(readFileSync(join(env.DSH_HOME, 'cordis.patch.yml'), 'utf8'), /kitto-mcp-/);
});

test('native Codex lists enabled TOML declarations in an isolated parity probe', { skip: !nativeBin }, async t => {
  const home = mkdtempSync(join(tmpdir(), 'kitto-native-codex-parity-'));
  t.onTestFinished(() => rmSync(home, { recursive: true, force: true }));
  const config = join(home, 'config.toml');
  const text = `[mcp_servers.alpha] # bare table
command = "fixture-must-not-run"
[mcp_servers."dot.name"] # quoted table
command = "fixture-must-not-run"
[mcp_servers.muted]
command = "fixture-must-not-run"
enabled = false
`;
  writeFileSync(config, text);
  assert.deepEqual(await codexMcpNames(home, { codex: resolve(nativeBin, 'codex') }), ['alpha', 'dot.name']);
  assert.equal(readFileSync(config, 'utf8'), text);
});
