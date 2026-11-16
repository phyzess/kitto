import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Invoked separately after installing the pinned hosts. No login or model calls.
const root = fileURLToPath(new URL('../', import.meta.url));
const nativeBin = process.env.KITTO_NATIVE_BIN;
test('native Pi/Codex/DSH installation, version change, recovery, detach and reinstall', { skip: !nativeBin, timeout: 240_000 }, t => {
  const temp = mkdtempSync(join(tmpdir(), "kitto native's "));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const home = join(temp, 'home'), source = join(temp, 'config'), previous = join(temp, 'previous');
  for (const dir of [home, previous, join(source, 'config/pi'), join(source, 'skills/example')]) mkdirSync(dir, { recursive: true });
  const env = { ...process.env, HOME: home, KITTO_HOME: join(home, 'kitto'),
    PI_CODING_AGENT_DIR: join(home, 'pi'), PI_AGENTS_DIR: join(home, '.agents'), CODEX_HOME: join(home, 'codex'),
    DSH_HOME: join(home, 'dsh'), DSH_AGENTS_HOME: join(home, '.agents'), KITTO_UPDATE_CHECK: '0',
    PATH: `${resolve(nativeBin)}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const run = (command, args) => execFileSync(command, args, { env, cwd: home, encoding: 'utf8', timeout: 90_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const json = path => JSON.parse(readFileSync(path, 'utf8'));
  const state = () => json(join(env.KITTO_HOME, 'state.json'));
  const cli = (directory, ...args) => run(process.execPath, [join(directory, 'bin/kitto.mjs'), 'setup', ...args]);
  const maintain = (...args) => run(process.execPath, [join(env.KITTO_HOME, 'runtime/bin/maintain.mjs'), ...args]);
  const files = {
    '.gitignore': 'config/pi/local/\n',
    'config/pi/settings.json': '{"packages":[],"quietStartup":true}',
    'config/pi/mcp.json': '{"mcpServers":{}}', 'config/pi/AGENTS.md': 'Personal configuration fixture.',
    'config/pi/i-have-adhd-always': '', 'config/env.example': '# no credentials\n',
    'skills/example/SKILL.md': '---\nname: example\ndescription: A personal example task.\n---\nPreserve this personal skill.\n',
  };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(source, name), text);
  for (const args of [['init', '-b', 'main'], ['config', 'user.email', 'test@example.invalid'], ['config', 'user.name', 'Kitto test'], ['add', '.'], ['commit', '-m', 'fixture']]) run('git', ['-C', source, ...args]);
  const sourceHead = run('git', ['-C', source, 'rev-parse', 'HEAD']);
  for (const name of ['package.json', 'bin', 'lib', 'integration', 'sync.sh', 'CHANGELOG.md']) {
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
  cli(previous, '--agents', 'pi,codex,dsh', '--source', source, '--dsh-profile', profile);
  assert.equal(pluginVersion(), '0.0.0-native.1');
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
  const preview = maintain('remove');
  assert.match(preview, /Keep configuration/);
  assert.equal(pluginVersion(), nativeVersion);
  maintain('remove', '--apply'); maintain('remove', '--apply');
  assert.equal(state().detached, true);
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
  assert(dshProfile().dsh.profile.bundles.includes('@phyzess/kitto'));
});
