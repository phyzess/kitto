import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, symlinkSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOptions } from '../lib/kitto.mjs';
import { newerStable, updateNotice } from '../lib/update-notice.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
function command(cmd, args, env, cwd = root) {
  return spawnSync(cmd, args, { env, cwd, encoding: 'utf8', timeout: 60_000 });
}
function fixture(t) {
  const temp = mkdtempSync(join(tmpdir(), "kitto's test "));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const home = join(temp, 'home'), source = join(temp, 'source'), bin = join(temp, 'bin');
  for (const dir of [home, bin, join(source, 'config/pi'), join(source, 'skills/example'), join(source, 'lists')]) mkdirSync(dir, { recursive: true });
  const files = {
    'config/pi/settings.json': '{"packages": []}', 'config/pi/mcp.json': '{"mcpServers": {}}',
    'config/pi/AGENTS.md': 'Pi instructions', 'config/pi/i-have-adhd-always': '',
    'config/env.example': '# no secrets', 'skills/example/SKILL.md': '---\nname: example\ndescription: Example task\n---\nExample body',
  };
  for (const [name, content] of Object.entries(files)) writeFileSync(join(source, name), content);
  const log = join(temp, 'calls.jsonl');
  for (const name of ['pi', 'codex', 'dsh', 'pnpm']) {
    writeFileSync(join(bin, name), `#!${process.execPath}\nrequire(${JSON.stringify(join(root, 'tests/helpers/fake-agent.cjs'))});\n`, { mode: 0o755 });
  }
  const env = { ...process.env, HOME: home, KITTO_HOME: join(home, 'kitto'), PATH: `${bin}:${process.env.PATH}`, CALL_LOG: log,
    PI_CODING_AGENT_DIR: join(home, 'pi'), PI_AGENTS_DIR: join(home, '.agents'), DSH_AGENTS_HOME: join(home, '.agents'),
    DSH_HOME: join(home, 'dsh'), CODEX_HOME: join(home, 'codex'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const args of [['init', '-b', 'main'], ['config', 'user.email', 'test@example.invalid'], ['config', 'user.name', 'Test'], ['add', '.'], ['commit', '-m', 'fixture']]) {
    const result = command('git', args, env, source); assert.equal(result.status, 0, result.stderr);
  }
  const cli = (...args) => command(process.execPath, [join(root, 'bin/kitto.mjs'), ...args], env);
  const maintain = (...args) => command(process.execPath, [join(env.KITTO_HOME, 'runtime/bin/maintain.mjs'), ...args], env);
  return { temp, home, source, env, cli, maintain, log };
}
const good = result => assert.equal(result.status, 0, result.stdout + result.stderr);
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
function release(f, version) {
  const directory = join(f.temp, version);
  mkdirSync(directory);
  for (const name of ['package.json', 'bin', 'lib', 'integration', 'sync.sh', 'CHANGELOG.md']) {
    cpSync(join(root, name), join(directory, name), { recursive: true, filter: path => !path.includes('__pycache__') });
  }
  for (const name of ['package.json', 'integration/plugin.json']) {
    const file = join(directory, name), data = readJson(file); data.version = version; writeFileSync(file, JSON.stringify(data));
  }
  return (...args) => command(process.execPath, [join(directory, 'bin/kitto.mjs'), 'setup', ...args], f.env);
}

test('public options reject unknown hosts, flags and missing values', () => {
  assert.deepEqual(parseOptions(['--agents', 'pi,codex,pi']).agents, ['pi', 'codex']);
  for (const args of [['--agents', 'other'], ['--source'], ['--run'], ['--agents', 'pi,'], ['--recover', '--agents', 'pi']]) assert.throws(() => parseOptions(args));
});

test('self-update notice is rate-limited, ignores prereleases, and tolerates offline', async t => {
  const f = fixture(t), cache = join(f.home, 'notice');
  assert.equal(newerStable('0.2.0-rc.1', '0.1.0'), false);
  assert.equal(newerStable('0.1.0', '0.1.0-dev.0'), true);
  assert.equal(newerStable('0.1.0', '0.2.0'), false);
  let calls = 0;
  const fetcher = async () => { calls++; return { ok: true, json: async () => ({ version: '0.2.0' }) }; };
  assert.match(await updateNotice(cache, '0.1.0', { fetcher, now: 100 }), /0.2.0/);
  assert.equal(await updateNotice(cache, '0.1.0', { fetcher, now: 200 }), undefined);
  assert.equal(calls, 1);
  assert.equal(await updateNotice(cache, '0.1.0', { fetcher: async () => { throw new Error('offline'); }, now: 86_400_101 }), undefined);
});

test('setup preview leaves home and source unchanged', t => {
  const f = fixture(t);
  const before = readdirSync(f.home);
  good(f.cli('setup', '--agents', 'pi,codex,dsh', '--source', f.source, '--dry-run'));
  assert.deepEqual(readdirSync(f.home), before);
  assert.equal(command('git', ['status', '--porcelain'], f.env, f.source).stdout, '');
  const calls = readFileSync(f.log, 'utf8');
  assert.doesNotMatch(calls, /"install"|"marketplace"/);
});

test('missing DSH package manager is detected before writes and included in installation preview', t => {
  const f = fixture(t);
  writeFileSync(join(f.temp, 'bin/pnpm'), `#!${process.execPath}\nprocess.exit(1);\n`, { mode: 0o755 });
  const result = f.cli('setup', '--agents', 'dsh', '--source', f.source);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /require pnpm/);
  assert.equal(existsSync(f.env.KITTO_HOME), false);
  const preview = f.cli('setup', '--agents', 'dsh', '--source', f.source, '--install-agents', '--dry-run');
  good(preview); assert.match(preview.stdout, /Install missing DSH prerequisite: pnpm@12.21.0/);
  assert.equal(existsSync(f.env.KITTO_HOME), false);
});

test('setup persists code, keeps private assets out, and registers all native integrations', t => {
  const f = fixture(t);
  writeFileSync(join(f.source, 'config/pi/mcp.private.json'), '{"YOUR_SECRET":"fixture"}');
  good(f.cli('setup', '--agents', 'pi,codex,dsh', '--source', f.source));
  const runtime = join(f.env.KITTO_HOME, 'runtime');
  assert.equal(existsSync(join(runtime, 'config')), false);
  assert.equal(existsSync(join(runtime, 'skills')), false);
  const skill = readFileSync(join(runtime, 'integration/skills/kitto/SKILL.md'), 'utf8');
  assert.doesNotMatch(skill, /KITTO_RUNNER/);
  assert.match(skill, /'\\''/); // A quote in the home path remains shell-safe.
  assert.equal(JSON.parse(readFileSync(join(f.env.KITTO_HOME, 'state.json'))).ready, true);
  good(f.maintain('status'));
  good(f.cli('setup')); // Saved source/hosts reused, no manual clone or flags.
  const calls = readFileSync(f.log, 'utf8').trim().split('\n').map(JSON.parse);
  assert(calls.some(c => c.command === 'pi' && c.args[0] === 'install' && c.args[1] === runtime));
  assert(calls.some(c => c.command === 'codex' && c.args.join(' ') === 'plugin add kitto@phyzess-kitto'));
  assert(calls.some(c => c.command === 'dsh' && c.args.join(' ') === `plugin --profile web add ${runtime}`));
});

test('a conflicting existing shared skill stops setup before runtime or host changes', t => {
  const f = fixture(t), target = join(f.env.PI_AGENTS_DIR, 'skills/example');
  mkdirSync(target, { recursive: true }); writeFileSync(join(target, 'SKILL.md'), 'local work');
  const result = f.cli('setup', '--agents', 'codex', '--source', f.source);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Skill conflict/);
  assert.equal(readFileSync(join(target, 'SKILL.md'), 'utf8'), 'local work');
  assert.equal(existsSync(join(f.env.KITTO_HOME, 'runtime')), false);
});

test('owned skill updates and removals apply, local modifications stop sync', t => {
  const f = fixture(t), target = join(f.env.PI_AGENTS_DIR, 'skills/example/SKILL.md');
  good(f.cli('setup', '--agents', 'codex', '--source', f.source));
  writeFileSync(join(f.source, 'skills/example/SKILL.md'), 'new shared body');
  good(f.maintain('sync')); assert.doesNotMatch(readFileSync(target, 'utf8'), /new shared/);
  good(f.maintain('sync', '--apply')); assert.equal(readFileSync(target, 'utf8'), 'new shared body');
  writeFileSync(target, 'local edit');
  assert.notEqual(f.maintain('sync', '--apply').status, 0);
  assert.equal(readFileSync(target, 'utf8'), 'local edit');
  writeFileSync(target, 'new shared body');
  rmSync(join(f.source, 'skills/example'), { recursive: true });
  good(f.maintain('sync', '--apply')); assert.equal(existsSync(target), false);
});

test('foreign symlinks are preserved and rejected', t => {
  const f = fixture(t), target = join(f.env.PI_AGENTS_DIR, 'skills/example');
  mkdirSync(join(f.env.PI_AGENTS_DIR, 'skills'), { recursive: true }); symlinkSync(f.temp, target);
  const result = f.cli('setup', '--agents', 'codex', '--source', f.source);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /links elsewhere/);
});

test('failed native registration is resumable and holds no stale lock', t => {
  const f = fixture(t); f.env.FAIL_HOST = 'codex';
  assert.notEqual(f.cli('setup', '--agents', 'codex', '--source', f.source).status, 0);
  assert.equal(JSON.parse(readFileSync(join(f.env.KITTO_HOME, 'state.json'))).ready, false);
  assert.equal(existsSync(join(f.env.KITTO_HOME, '.lock')), false);
  delete f.env.FAIL_HOST;
  good(f.cli('setup'));
  assert.equal(JSON.parse(readFileSync(join(f.env.KITTO_HOME, 'state.json'))).ready, true);
});

test('maintenance runner finds custom home without inheriting setup environment', t => {
  const f = fixture(t);
  good(f.cli('setup', '--agents', 'codex', '--source', f.source));
  const runtime = f.env.KITTO_HOME;
  delete f.env.KITTO_HOME;
  good(command(process.execPath, [join(runtime, 'runtime/bin/maintain.mjs'), 'status'], f.env));
});

test('lock rejects concurrent mutation and dirty source rejects update', t => {
  const f = fixture(t);
  good(f.cli('setup', '--agents', 'codex', '--source', f.source));
  mkdirSync(join(f.env.KITTO_HOME, '.lock'));
  assert.match(f.maintain('sync', '--apply').stderr, /Another Kitto operation/);
  rmSync(join(f.env.KITTO_HOME, '.lock'), { recursive: true });
  writeFileSync(join(f.source, 'uncommitted.txt'), 'work');
  assert.match(f.maintain('update', '--apply').stderr, /local changes/);
  assert.equal(readFileSync(join(f.source, 'uncommitted.txt'), 'utf8'), 'work');
});

test('remote bootstrap clones internally and later updates only by fast-forward', t => {
  const f = fixture(t), mirror = join(f.temp, 'remote.git');
  good(command('git', ['clone', '--bare', f.source, mirror], f.env));
  const config = join(f.temp, 'gitconfig');
  writeFileSync(config, ''); f.env.GIT_CONFIG_GLOBAL = config;
  good(command('git', ['config', '--file', config, `url.${mirror}.insteadOf`, 'https://kitto.invalid/config.git'], f.env));
  good(f.cli('setup', '--agents', 'codex', '--source', 'https://kitto.invalid/config.git', '--ref', 'main'));
  const managed = join(f.env.KITTO_HOME, 'config');
  assert.equal(JSON.parse(readFileSync(join(f.env.KITTO_HOME, 'state.json'))).source, managed);
  good(command('git', ['remote', 'add', 'origin', mirror], f.env, f.source));
  writeFileSync(join(f.source, 'skills/example/SKILL.md'), 'new remote skill');
  for (const args of [['add', '.'], ['commit', '-m', 'update'], ['push', 'origin', 'main']]) good(command('git', args, f.env, f.source));
  const before = command('git', ['rev-parse', 'HEAD'], f.env, managed).stdout;
  good(f.maintain('update'));
  assert.equal(command('git', ['rev-parse', 'HEAD'], f.env, managed).stdout, before);
  good(f.maintain('update', '--apply'));
  assert.notEqual(command('git', ['rev-parse', 'HEAD'], f.env, managed).stdout, before);
  assert.equal(readFileSync(join(f.env.PI_AGENTS_DIR, 'skills/example/SKILL.md'), 'utf8'), 'new remote skill');
});

test('packed installation survives removal of the npm execution directory', t => {
  const f = fixture(t);
  const packed = command('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', f.temp], f.env);
  good(packed);
  const archive = join(f.temp, JSON.parse(packed.stdout)[0].filename), extracted = join(f.temp, 'extracted');
  mkdirSync(extracted);
  good(command('tar', ['-xzf', archive, '-C', extracted], f.env));
  good(command(process.execPath, [join(extracted, 'package/bin/kitto.mjs'), 'setup', '--agents', 'codex', '--source', f.source], f.env));
  rmSync(extracted, { recursive: true });
  good(f.maintain('status'));
  good(f.maintain('versions'));
});

test('packed npm artifact excludes personal configuration and all undeclared assets', t => {
  const f = fixture(t);
  const result = command('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], f.env);
  good(result);
  const paths = JSON.parse(result.stdout)[0].files.map(file => file.path);
  assert(paths.includes('integration/skills/kitto/SKILL.md'));
  assert(paths.includes('bin/kitto.mjs'));
  for (const path of paths) assert.match(path, /^(bin\/[^/]+\.mjs|lib\/[^/]+\.(mjs|py)|integration\/|sync\.sh$|package\.json$|README\.md$|CHANGELOG\.md$)/);
  assert(!paths.some(path => /^(config|skills|lists|tests)\//.test(path)));
});

test('failed upgrade retries preserve the working checkpoint, and external setup recovers broken code', t => {
  const f = fixture(t), a = release(f, '0.1.0-test.1'), b = release(f, '0.1.0-test.2');
  good(a('--agents', 'codex', '--source', f.source));
  f.env.FAIL_HOST = 'codex';
  assert.notEqual(b().status, 0);
  const checkpoint = join(f.env.KITTO_HOME, 'runtime.previous.json'), before = readFileSync(checkpoint, 'utf8');
  assert.equal(readJson(checkpoint).version, '0.1.0-test.1');
  assert.notEqual(b().status, 0);
  assert.equal(readFileSync(checkpoint, 'utf8'), before);
  const statePath = join(f.env.KITTO_HOME, 'state.json'), state = readFileSync(statePath, 'utf8');
  good(f.maintain('recover'));
  assert.equal(readFileSync(statePath, 'utf8'), state);
  // Recovery works even with a missing personal checkout and a broken runner.
  rmSync(f.source, { recursive: true });
  writeFileSync(join(f.env.KITTO_HOME, 'runtime/bin/maintain.mjs'), 'broken syntax !');
  good(f.cli('setup', '--recover', '--dry-run'));
  assert.notEqual(f.cli('setup', '--recover').status, 0); // Native reconnection can also fail.
  assert.equal(readJson(statePath).ready, false);
  assert.equal(readFileSync(checkpoint, 'utf8'), before);
  delete f.env.FAIL_HOST;
  good(f.cli('setup', '--recover'));
  assert.equal(readJson(statePath).version, '0.1.0-test.1');
  assert.equal(readJson(statePath).ready, true);
  assert.deepEqual(readJson(statePath).skills, JSON.parse(state).skills);
  assert.equal(readFileSync(join(f.env.PI_AGENTS_DIR, 'skills/example/SKILL.md'), 'utf8').includes('Example body'), true);
  good(f.maintain('status'));
});

test('same-version setup and generated Python cache do not erase a prior version checkpoint', t => {
  const f = fixture(t), a = release(f, '0.1.0-test.1'), b = release(f, '0.1.0-test.2');
  good(a('--agents', 'codex', '--source', f.source)); good(b());
  const cache = join(f.env.KITTO_HOME, 'runtime/lib/__pycache__'); mkdirSync(cache);
  writeFileSync(join(cache, 'local.pyc'), 'generated');
  good(b());
  assert.equal(readJson(join(f.env.KITTO_HOME, 'runtime.previous.json')).version, '0.1.0-test.1');
  good(f.maintain('recover', '--apply'));
  assert.equal(readJson(join(f.env.KITTO_HOME, 'state.json')).version, '0.1.0-test.1');
});

test('tampered checkpoint is rejected without changing the active installation', t => {
  const f = fixture(t), a = release(f, '0.1.0-test.1'), b = release(f, '0.1.0-test.2');
  good(a('--agents', 'codex', '--source', f.source)); good(b());
  writeFileSync(join(f.env.KITTO_HOME, 'runtime.previous/lib/kitto.mjs'), 'modified');
  assert.match(f.maintain('recover', '--apply').stderr, /checkpoint was modified/);
  assert.equal(readJson(join(f.env.KITTO_HOME, 'state.json')).version, '0.1.0-test.2');
  assert.equal(existsSync(join(f.env.KITTO_HOME, '.lock')), false);
});

test('native removal is previewable and repeatable, preserves personal assets and allows reinstall', t => {
  const f = fixture(t);
  good(f.cli('setup', '--agents', 'pi,codex,dsh', '--source', f.source));
  good(f.maintain('sync', '--apply')); // Pi remembers its Kitto source as machine-only.
  const codexFile = join(f.env.CODEX_HOME, '_fake-codex.json'), other = readJson(codexFile);
  other.installed.push({ pluginId: 'other@personal', marketplaceName: 'personal' });
  other.marketplaces.push({ name: 'personal', root: '/other' }); writeFileSync(codexFile, JSON.stringify(other));
  const dshFile = join(f.env.DSH_HOME, 'profiles/web/package.json'), profile = readJson(dshFile);
  profile.dependencies.other = '1.0.0'; profile.dsh.profile.bundles.push('other'); writeFileSync(dshFile, JSON.stringify(profile));
  const sourceHead = command('git', ['rev-parse', 'HEAD'], f.env, f.source).stdout;
  const files = [codexFile, dshFile, join(f.env.PI_CODING_AGENT_DIR, 'settings.json'), join(f.env.KITTO_HOME, 'state.json')];
  const before = files.map(file => readFileSync(file, 'utf8'));
  good(f.maintain('remove'));
  assert.deepEqual(files.map(file => readFileSync(file, 'utf8')), before);
  good(f.maintain('remove', '--apply')); good(f.maintain('remove', '--apply'));
  assert.equal(readJson(files[3]).detached, true);
  assert.deepEqual(readJson(codexFile).installed.map(x => x.pluginId), ['other@personal']);
  assert.deepEqual(readJson(codexFile).marketplaces.map(x => x.name), ['personal']);
  assert.equal(readJson(dshFile).dependencies.other, '1.0.0');
  assert(readJson(dshFile).dsh.profile.bundles.includes('other'));
  assert.equal(readJson(files[2]).packages.length, 0);
  assert.doesNotMatch(readFileSync(join(f.source, 'config/pi/local/packages.txt'), 'utf8'), /kitto\/runtime/);
  assert.equal(command('git', ['rev-parse', 'HEAD'], f.env, f.source).stdout, sourceHead);
  assert(existsSync(join(f.env.PI_AGENTS_DIR, 'skills/example/SKILL.md')));
  assert.match(f.maintain('sync', '--apply').stderr, /detached/);
  good(f.cli('setup'));
  assert.equal(readJson(files[3]).ready, true);
  assert.equal(readJson(files[3]).detached, false);
  assert(readJson(codexFile).installed.some(x => x.pluginId === 'kitto@phyzess-kitto'));
});

test('partially completed removal resumes after a native failure without needing the source checkout', t => {
  const f = fixture(t);
  good(f.cli('setup', '--agents', 'pi,codex,dsh', '--source', f.source));
  f.env.FAIL_HOST = 'codex'; f.env.FAIL_ACTION = 'remove'; f.env.FAIL_STAGE = 'marketplace';
  assert.notEqual(f.maintain('remove', '--apply').status, 0);
  const path = join(f.env.KITTO_HOME, 'state.json');
  assert.deepEqual(readJson(path).removedAgents, ['pi']);
  assert.equal(readJson(path).removing, true);
  assert.equal(existsSync(join(f.env.KITTO_HOME, '.lock')), false);
  rmSync(f.source, { recursive: true }); delete f.env.FAIL_HOST;
  good(f.maintain('remove', '--apply'));
  assert.equal(readJson(path).detached, true);
  const calls = readFileSync(f.log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(x => x.command === 'pi' && x.args[0] === 'remove').length, 1);
  good(f.maintain('status'));
});

test('foreign native registration stops removal before detaching any host', t => {
  const f = fixture(t);
  good(f.cli('setup', '--agents', 'pi,codex', '--source', f.source));
  const file = join(f.env.CODEX_HOME, '_fake-codex.json'), data = readJson(file);
  data.marketplaces[0].root = '/foreign'; writeFileSync(file, JSON.stringify(data));
  assert.match(f.maintain('remove', '--apply').stderr, /another location/);
  assert.equal(readJson(join(f.env.PI_CODING_AGENT_DIR, 'settings.json')).packages.length, 1);
  assert.equal(readJson(join(f.env.KITTO_HOME, 'state.json')).ready, true);
  const alias = join(f.temp, 'kitto-alias'); symlinkSync(f.env.KITTO_HOME, alias);
  data.marketplaces[0].root = alias; writeFileSync(file, JSON.stringify(data));
  good(f.maintain('remove', '--apply'));
  assert.equal(readJson(join(f.env.KITTO_HOME, 'state.json')).detached, true);
});

for (const agent of ['codex', 'dsh']) {
  test(`${agent}-only setup, sync and versions work without Pi files, Bash or Python`, t => {
    const f = fixture(t);
    rmSync(join(f.source, 'config/pi'), { recursive: true });
    const bin = join(f.temp, 'bin');
    const git = command('which', ['git'], f.env).stdout.trim();
    symlinkSync(git, join(bin, 'git'));
    f.env.PATH = bin;
    const home = f.env[agent === 'codex' ? 'CODEX_HOME' : 'DSH_HOME'];
    mkdirSync(join(f.source, 'config', agent, 'skills/host-example'), { recursive: true });
    writeFileSync(join(f.source, 'config', agent, 'skills/host-example/SKILL.md'), 'Host only');
    const source = join(f.source, 'config', agent, 'AGENTS.md');
    writeFileSync(source, 'Portable rules');
    mkdirSync(home, { recursive: true });
    const instructions = join(home, 'AGENTS.md');
    writeFileSync(instructions, 'My local rules\n');
    const options = agent === 'dsh' ? ['--dsh-profile', 'headless'] : [];
    good(f.cli('setup', '--agents', agent, '--source', f.source, ...options));
    assert.match(readFileSync(instructions, 'utf8'), /My local rules\n.*\nPortable rules/);
    assert.equal(readFileSync(join(home, 'skills/host-example/SKILL.md'), 'utf8'), 'Host only');
    assert(!existsSync(join(f.env.PI_AGENTS_DIR, 'skills/host-example')));
    const versions = f.maintain('versions');
    good(versions);
    const report = JSON.parse(versions.stdout);
    assert(report.components.some(row => row.owner === agent && row.tested));
    assert(!report.components.some(row => row.owner === 'pi' || row.upstream));
    assert(report.components.some(row => row.owner === agent && row.kind === 'skill' && row.contentSha256));
    good(f.maintain('deps', '--apply'));
    assert(!existsSync(f.env.PI_CODING_AGENT_DIR));
    writeFileSync(source, 'Updated portable rules');
    good(f.maintain('sync', '--apply'));
    assert.match(readFileSync(instructions, 'utf8'), /My local rules\n.*\nUpdated portable rules/);
    const updated = readFileSync(instructions, 'utf8');
    writeFileSync(instructions, updated.replace('Updated portable rules', 'Edited locally'));
    assert.match(f.maintain('sync', '--apply').stderr, /Local changes inside/);
    assert.match(readFileSync(instructions, 'utf8'), /Edited locally/);
    if (agent === 'dsh') {
      writeFileSync(instructions, updated);
      const path = join(home, 'profiles/headless/package.json');
      assert(readJson(path).dependencies['@phyzess/kitto']);
      assert(report.components.some(row => row.profile === 'headless' && row.name === '@phyzess/kitto'));
      good(f.cli('setup'));
      good(f.maintain('remove', '--apply'));
      assert(!readJson(path).dependencies['@phyzess/kitto']);
      assert(!existsSync(join(home, 'profiles/web')));
    }
  });
}

test('dependency previews use enabled Pi MCP commands and deduplicate shared tools', t => {
  const f = fixture(t);
  mkdirSync(join(f.source, 'skills/codegraph'));
  writeFileSync(join(f.source, 'skills/codegraph/SKILL.md'), 'CodeGraph skill');
  writeFileSync(join(f.source, 'lists/mise-tools.txt'), 'dap-mcp-server 0.1.17\n');
  writeFileSync(join(f.source, 'config/pi/mcp.json'), JSON.stringify({ mcpServers: {
    codegraph: { command: 'codegraph' },
    debug: { command: 'dap-mcp-server', enabled: false },
  } }));
  good(f.cli('setup', '--agents', 'pi,codex', '--source', f.source));
  const preview = f.maintain('deps');
  good(preview);
  assert.equal(preview.stdout.match(/(?:Missing|Available): codegraph/g)?.length, 1);
  assert.match(preview.stdout, /shared skill codegraph, Pi MCP codegraph/);
  assert.doesNotMatch(preview.stdout, /dap-mcp-server/);
  const file = join(f.env.PI_CODING_AGENT_DIR, 'mcp.json');
  const config = readJson(file);
  config.mcpServers.debug.enabled = true;
  writeFileSync(file, JSON.stringify(config));
  const enabled = f.maintain('deps');
  good(enabled);
  assert.match(enabled.stdout, /dap-mcp-server.*Pi MCP debug/);
});

test('first setup retries from its own clone and rejects unregistered or changed remotes', t => {
  const f = fixture(t), mirror = join(f.temp, 'remote.git');
  good(command('git', ['clone', '--bare', f.source, mirror], f.env));
  const config = join(f.temp, 'gitconfig'), url = 'https://kitto.invalid/config.git';
  writeFileSync(config, ''); f.env.GIT_CONFIG_GLOBAL = config;
  good(command('git', ['config', '--file', config, `url.${mirror}.insteadOf`, url], f.env));
  const conflict = join(f.env.PI_AGENTS_DIR, 'skills/example');
  mkdirSync(conflict, { recursive: true });
  writeFileSync(join(conflict, 'SKILL.md'), 'local work');
  const args = ['setup', '--agents', 'codex', '--source', url, '--ref', 'main'];
  const managed = join(f.env.KITTO_HOME, 'config');
  mkdirSync(managed, { recursive: true });
  assert.match(f.cli(...args).stderr, /Unregistered checkout/);
  rmSync(managed, { recursive: true });
  assert.match(f.cli(...args).stderr, /Skill conflict/);
  assert(!existsSync(join(f.env.KITTO_HOME, 'state.json')));
  rmSync(conflict, { recursive: true });
  good(command('git', ['remote', 'set-url', 'origin', 'https://kitto.invalid/another.git'], f.env, managed));
  assert.match(f.cli(...args).stderr, /Unregistered checkout/);
  good(command('git', ['remote', 'set-url', 'origin', url], f.env, managed));
  writeFileSync(join(managed, 'local-note'), 'preserve this');
  const retried = f.cli(...args);
  good(retried);
  assert.match(retried.stdout, /Resume setup/);
  assert.equal(readFileSync(join(managed, 'local-note'), 'utf8'), 'preserve this');
  assert.equal(readJson(join(f.env.KITTO_HOME, 'state.json')).ready, true);
});

test('dependency apply reports missing installers and checks successful installs', t => {
  const f = fixture(t);
  writeFileSync(join(f.source, 'lists/mise-tools.txt'), 'dap-mcp-server 0.1.17\n');
  writeFileSync(join(f.source, 'config/pi/mcp.json'), '{"mcpServers":{"debug":{"command":"dap-mcp-server"}}}');
  good(f.cli('setup', '--agents', 'pi', '--source', f.source));
  const bin = join(f.temp, 'bin');
  const git = command('which', ['git'], f.env).stdout.trim();
  symlinkSync(git, join(bin, 'git'));
  f.env.PATH = bin;
  const preview = f.maintain('deps');
  good(preview);
  assert.match(preview.stdout, /Missing installer mise/);
  const blocked = f.maintain('deps', '--apply');
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stdout, /Unresolved managed dependencies: dap-mcp-server \(missing mise\)/);
  writeFileSync(join(bin, 'mise'), `#!${process.execPath}\nif (process.argv[2] === "current") console.log("0.1.17");\n`, { mode: 0o755 });
  const unavailable = f.maintain('deps', '--apply');
  assert.notEqual(unavailable.status, 0);
  assert.match(unavailable.stdout, /still unavailable after install/);
  writeFileSync(join(bin, 'dap-mcp-server'), `#!${process.execPath}\n`, { mode: 0o755 });
  const ready = f.maintain('deps', '--apply');
  good(ready);
  assert.match(ready.stdout, /Ready: dap-mcp-server/);
});

test('tag install pins a snapshot and managed setup can switch it without losing local changes', t => {
  const f = fixture(t), mirror = join(f.temp, 'remote.git');
  const git = (...args) => command('git', args, f.env, f.source);
  const first = git('rev-parse', 'HEAD').stdout.trim();
  good(git('tag', 'v1'));
  writeFileSync(join(f.source, 'skills/example/SKILL.md'), 'second snapshot');
  good(git('add', '.'));
  good(git('commit', '-m', 'second snapshot'));
  const second = git('rev-parse', 'HEAD').stdout.trim();
  good(git('tag', 'v2'));
  good(git('clone', '--bare', f.source, mirror));
  const config = join(f.temp, 'gitconfig'), url = 'https://kitto.invalid/config.git';
  writeFileSync(config, ''); f.env.GIT_CONFIG_GLOBAL = config;
  good(git('config', '--file', config, `url.${mirror}.insteadOf`, url));
  good(f.cli('setup', '--agents', 'codex', '--source', url, '--ref', 'v1'));
  const state = () => readJson(join(f.env.KITTO_HOME, 'state.json'));
  assert.deepEqual(state().deployed, { commit: first, dirty: false, detached: true });
  assert.match(f.maintain('update', '--apply').stderr, /pinned to a detached revision/);
  const note = join(state().source, 'local-note');
  writeFileSync(note, 'local work');
  assert.match(f.cli('setup', '--ref', 'v2').stderr, /local changes/);
  assert.equal(readFileSync(note, 'utf8'), 'local work');
  rmSync(note);
  const deployedSkill = join(f.env.PI_AGENTS_DIR, 'skills/example/SKILL.md');
  const original = readFileSync(deployedSkill, 'utf8');
  writeFileSync(deployedSkill, 'manual change');
  assert.match(f.cli('setup', '--ref', 'v2').stderr, /Skill conflict/);
  assert.equal(state().deployed.commit, first);
  writeFileSync(deployedSkill, original);
  good(f.cli('setup', '--ref', 'v2'));
  assert.equal(state().deployed.commit, second);
  assert.equal(readFileSync(deployedSkill, 'utf8'), 'second snapshot');
});

test('dependency declarations follow the selected host and reject conflicting versions', t => {
  const f = fixture(t);
  good(f.cli('setup', '--agents', 'codex', '--source', f.source));
  const manifest = join(f.source, 'config/dependencies.json');
  const rule = { agent: 'codex', executable: 'test-tool', install: { mise: 'npm:test-tool@1.2.3' } };
  writeFileSync(manifest, JSON.stringify([rule, rule, { agent: 'pi', executable: 'pi-only' }]));
  const preview = f.maintain('deps');
  good(preview);
  assert.equal(preview.stdout.split('\n').filter(line => line.includes('test-tool')).length, 1);
  assert.doesNotMatch(preview.stdout, /pi-only/);
  writeFileSync(manifest, JSON.stringify([rule, { ...rule, install: { mise: 'npm:test-tool@2.0.0' } }]));
  assert.match(f.maintain('deps', '--apply').stderr, /Conflicting dependency declarations/);
});
