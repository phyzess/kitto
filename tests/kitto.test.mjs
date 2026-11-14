import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, symlinkSync } from 'node:fs';
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
  for (const [name, version] of [['pi', '1.5.2'], ['codex', '0.169.0'], ['dsh', '0.2.2-rc.3']]) {
    writeFileSync(join(bin, name), `#!${process.execPath}\nconst fs=require('node:fs'); fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({command:${JSON.stringify(name)},args:process.argv.slice(2)})+'\\n'); if(process.argv.includes('--version')) console.log(${JSON.stringify(version)}); if(process.env.FAIL_HOST===${JSON.stringify(name)} && process.argv.includes('add') && !process.argv.includes('--help')) process.exit(9);\n`, { mode: 0o755 });
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

test('public options reject unknown hosts, flags and missing values', () => {
  assert.deepEqual(parseOptions(['--agents', 'pi,codex,pi']).agents, ['pi', 'codex']);
  for (const args of [['--agents', 'other'], ['--source'], ['--run'], ['--agents', 'pi,']]) assert.throws(() => parseOptions(args));
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
