import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, symlinkSync, cpSync, chmodSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeDesktopProfile } from '../lib/dsh-profile.mjs';
import { compareVersions } from '../lib/hosts.mjs';
import { parseOptions, replaceDirectory, treeHash } from '../lib/kitto.mjs';
import { newerStable, updateNotice } from '../lib/update-notice.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
function command(cmd, args, env, cwd = root) {
  return spawnSync(cmd, args, { env, cwd, encoding: 'utf8', timeout: 60_000 });
}
function fixture(t) {
  const temp = mkdtempSync(join(tmpdir(), "kitto's test "));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const home = join(temp, 'home'), source = join(temp, 'source'), bin = join(temp, 'bin');
  for (const dir of [home, bin, join(source, 'config/pi'), join(source, 'config/instructions'), join(source, 'skills/example'), join(source, 'lists')]) mkdirSync(dir, { recursive: true });
  const files = {
    'config/pi/settings.json': '{"packages": []}', 'config/pi/mcp.json': '{"mcpServers": {}}',
    'config/pi/AGENTS.md': 'Pi instructions', 'config/pi/i-have-adhd-always': '',
    'config/instructions/common.md': '# 共享规则\n\n- shared-marker: 先检查工具，CodeGraph 可用时优先。\n- 每次会话开始先加载 `i-have-adhd` skill。\n- 每次会话开始先加载 `hindsight` skill。\n',
    'config/env.example': '# no secrets', 'skills/example/SKILL.md': '---\nname: example\ndescription: Example task\n---\nExample body',
  };
  for (const [name, content] of Object.entries(files)) writeFileSync(join(source, name), content);
  const log = join(temp, 'calls.jsonl');
  for (const name of ['pi', 'codex', 'dsh', 'pnpm', 'codegraph']) {
    writeFileSync(join(bin, name), `#!${process.execPath}\nrequire(${JSON.stringify(join(root, 'tests/helpers/fake-agent.cjs'))});\n`, { mode: 0o755 });
  }
  const env = { ...process.env, HOME: home, KITTO_HOME: join(home, 'kitto'), PATH: `${bin}:${process.env.PATH}`, CALL_LOG: log,
    PI_CODING_AGENT_DIR: join(home, 'pi'), PI_AGENTS_DIR: join(home, '.agents'), DSH_AGENTS_HOME: join(home, '.agents'),
    DSH_HOME: join(home, 'dsh'), CODEX_HOME: join(home, 'codex'), FAKE_CODEX_STATE: join(home, 'codex/_fake-codex.json'),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const args of [['init', '-b', 'main'], ['config', 'user.email', 'test@example.invalid'], ['config', 'user.name', 'Test'], ['add', '.'], ['commit', '-m', 'fixture']]) {
    const result = command('git', args, env, source); assert.equal(result.status, 0, result.stderr);
  }
  const cli = (...args) => command(process.execPath, [join(root, 'bin/kitto.mjs'), ...args], env);
  const maintain = (...args) => command(process.execPath, [join(env.KITTO_HOME, 'runtime/bin/maintain.mjs'), ...args], env);
  return { temp, home, source, env, cli, maintain, log };
}
const good = result => assert.equal(result.status, 0, result.stdout + result.stderr);
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
function callsOf(f) {
  if (!existsSync(f.log)) return [];
  return readFileSync(f.log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}
function snapshot(directory) {
  if (!existsSync(directory)) return null;
  return readdirSync(directory, { recursive: true }).map(name => {
    const path = join(directory, name);
    return lstatSync(path).isDirectory() ? `dir:${name}` : `file:${name}:${readFileSync(path, 'utf8')}`;
  }).sort();
}
function release(f, version, operation = 'setup') {
  const directory = join(f.temp, version);
  mkdirSync(directory);
  for (const name of ['package.json', 'bin', 'lib', 'integration', 'sync.sh', 'CHANGELOG.md']) {
    cpSync(join(root, name), join(directory, name), { recursive: true, filter: path => !path.includes('__pycache__') });
  }
  for (const name of ['package.json', 'integration/plugin.json']) {
    const file = join(directory, name), data = readJson(file); data.version = version; writeFileSync(file, JSON.stringify(data));
  }
  return (...args) => command(process.execPath, [join(directory, 'bin/kitto.mjs'), operation, ...args], f.env);
}
const bootstrapMarkerFor = source => join(source, '.git', 'kitto-bootstrap.json');
// Give the fixture's own checkout an upstream branch so update may fast-forward it.
function withRemote(f) {
  const mirror = join(f.temp, 'remote.git');
  good(command('git', ['clone', '--bare', f.source, mirror], f.env));
  good(command('git', ['remote', 'add', 'origin', mirror], f.env, f.source));
  good(command('git', ['push', '-u', 'origin', 'main'], f.env, f.source));
  return mirror;
}
function commitAll(f, message = 'update') {
  for (const args of [['add', '.'], ['commit', '-m', message]]) good(command('git', args, f.env, f.source));
}
// Clone the fixture source into a bare mirror and map the given URLs onto it.
function mirrorOf(f, ...urls) {
  if (!urls.length) urls = ['https://kitto.invalid/config.git'];
  const mirror = join(f.temp, 'remote.git');
  good(command('git', ['clone', '--bare', f.source, mirror], f.env));
  const config = join(f.temp, 'gitconfig');
  writeFileSync(config, '');
  f.env.GIT_CONFIG_GLOBAL = config;
  for (const url of urls) good(command('git', ['config', '--add', '--file', config, `url.${mirror}.insteadOf`, url], f.env));
  return { mirror, config, url: urls[0] };
}

test('public options reject unknown hosts, flags and missing values', () => {
  assert.deepEqual(parseOptions(['--agents', 'pi,codex,pi']).agents, ['pi', 'codex']);
  for (const args of [['--agents', 'other'], ['--source'], ['--run'], ['--agents', 'pi,'], ['--recover', '--agents', 'pi']]) assert.throws(() => parseOptions(args));
});

test('skill directory replacement is atomic and leaves no backup', async t => {
  const temp = mkdtempSync(join(tmpdir(), 'kitto-replace-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const source = join(temp, 'source'), target = join(temp, 'target');
  mkdirSync(source);
  writeFileSync(join(source, 'SKILL.md'), 'new');
  mkdirSync(target);
  writeFileSync(join(target, 'SKILL.md'), 'old');
  await replaceDirectory(source, target);
  assert.equal(readFileSync(join(target, 'SKILL.md'), 'utf8'), 'new');
  assert.deepEqual(readdirSync(temp).sort(), ['source', 'target']);
});

test('Codex and DSH i-have-adhd skills are model-invocable and loaded at startup', () => {
  for (const host of ['codex', 'dsh']) {
    const skill = readFileSync(join(root, `config/${host}/skills/i-have-adhd/SKILL.md`), 'utf8');
    assert.doesNotMatch(skill, /disable-model-invocation/);
  }
  const common = readFileSync(join(root, 'config/instructions/common.md'), 'utf8');
  assert.match(common, /每次会话开始先加载 `i-have-adhd` skill/);
  assert.match(common, /每次会话开始先加载 `hindsight` skill/);
  const policy = readFileSync(join(root, 'config/codex/skills/i-have-adhd/agents/openai.yaml'), 'utf8');
  assert.match(policy, /allow_implicit_invocation: true/);
});

test('shared rules compose into all three hosts with addenda kept host-specific', t => {
  const f = fixture(t);
  for (const [host, text] of [['pi', 'Pi addendum only'], ['codex', 'Codex addendum only'], ['dsh', 'DSH addendum only']]) {
    mkdirSync(join(f.source, 'config', host), { recursive: true });
    writeFileSync(join(f.source, 'config', host, 'AGENTS.md'), text);
  }
  good(f.cli('setup', '--agents', 'pi,codex,dsh', '--source', f.source));
  const common = readFileSync(join(f.source, 'config/instructions/common.md'), 'utf8').trim();
  const files = {
    pi: join(f.env.PI_CODING_AGENT_DIR, 'AGENTS.md'),
    codex: join(f.env.CODEX_HOME, 'AGENTS.md'),
    dsh: join(f.env.DSH_HOME, 'AGENTS.md'),
  };
  const addenda = { pi: 'Pi addendum only', codex: 'Codex addendum only', dsh: 'DSH addendum only' };
  for (const [host, file] of Object.entries(files)) {
    const text = readFileSync(file, 'utf8');
    assert.equal(text.split(common).length - 1, 1, `${host}: shared rules must appear once`);
    assert.equal(text.split(addenda[host]).length - 1, 1, `${host}: own addendum must appear once`);
    for (const [other, addendum] of Object.entries(addenda)) {
      if (other !== host) assert.equal(text.includes(addendum), false, `${host} must not contain ${other}'s addendum`);
    }
  }
  const pi = readFileSync(files.pi, 'utf8');
  assert(pi.startsWith(common), 'the Pi file starts with the shared rules');
  assert.doesNotMatch(pi, /kitto:begin|kitto:end/, 'Pi keeps a whole-file deployment');
  assert.match(readFileSync(files.codex, 'utf8'), /<!-- kitto:begin -->[\s\S]*<!-- kitto:end -->/);
  assert.match(readFileSync(files.dsh, 'utf8'), /<!-- kitto:begin -->[\s\S]*<!-- kitto:end -->/);
});

test('shared rule edits redeploy to every host and preserve block-external content', t => {
  const f = fixture(t);
  mkdirSync(join(f.env.CODEX_HOME), { recursive: true });
  mkdirSync(join(f.env.DSH_HOME), { recursive: true });
  writeFileSync(join(f.env.CODEX_HOME, 'AGENTS.md'), 'Local Codex note\n');
  writeFileSync(join(f.env.DSH_HOME, 'AGENTS.md'), 'Local DSH note\n');
  good(f.cli('setup', '--agents', 'pi,codex,dsh', '--source', f.source));
  const commonPath = join(f.source, 'config/instructions/common.md');
  writeFileSync(commonPath, readFileSync(commonPath, 'utf8').replace('shared-marker', 'shared-marker-v2'));
  good(f.maintain('sync', '--apply'));
  const files = [join(f.env.PI_CODING_AGENT_DIR, 'AGENTS.md'), join(f.env.CODEX_HOME, 'AGENTS.md'), join(f.env.DSH_HOME, 'AGENTS.md')];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    assert.match(text, /shared-marker-v2/);
    assert.doesNotMatch(text, /shared-marker(?!-v2)/);
  }
  assert.match(readFileSync(files[1], 'utf8'), /^Local Codex note\n/);
  assert.match(readFileSync(files[2], 'utf8'), /^Local DSH note\n/);
  assert.match(readFileSync(files[0], 'utf8'), /Pi instructions/);
});

test('Pi export writes only the Pi addendum back to the source', t => {
  const f = fixture(t);
  good(f.cli('setup', '--agents', 'pi', '--source', f.source));
  const deployed = join(f.env.PI_CODING_AGENT_DIR, 'AGENTS.md');
  const addendumPath = join(f.source, 'config/pi/AGENTS.md');
  writeFileSync(deployed, readFileSync(deployed, 'utf8').replace('Pi instructions', 'Pi instructions from machine'));
  good(f.maintain('export', '--apply'));
  const exported = readFileSync(addendumPath, 'utf8');
  assert.equal(exported, 'Pi instructions from machine\n');
  assert.doesNotMatch(exported, /共享规则|shared-marker/);

  // A machine file that does not start with the current shared layer is refused.
  writeFileSync(deployed, '# legacy full AGENTS\n');
  const result = f.maintain('export', '--apply');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /host-specific section/);
  assert.equal(readFileSync(addendumPath, 'utf8'), exported);
});

test('a legacy whole-file Pi AGENTS is replaced once without duplicating shared rules', t => {
  const f = fixture(t);
  mkdirSync(join(f.env.PI_CODING_AGENT_DIR), { recursive: true });
  writeFileSync(join(f.env.PI_CODING_AGENT_DIR, 'AGENTS.md'), '# Pi Agent — 全局适配\n\n- legacy Pi-only rule\n');
  good(f.cli('setup', '--agents', 'pi', '--source', f.source));
  const text = readFileSync(join(f.env.PI_CODING_AGENT_DIR, 'AGENTS.md'), 'utf8');
  assert.equal(text.split('shared-marker').length - 1, 1);
  assert.match(text, /Pi instructions/);
  assert.doesNotMatch(text, /legacy Pi-only rule/);
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

test('DSH desktop setup deploys global rules and skills without pnpm, bundle or profile patch', t => {
  const f = fixture(t);
  const hostSkill = join(f.source, 'config/dsh/skills/desktop-example');
  mkdirSync(hostSkill, { recursive: true });
  writeFileSync(join(hostSkill, 'SKILL.md'), 'Desktop host skill');
  writeFileSync(join(f.source, 'config/dsh/AGENTS.md'), 'Desktop portable rules');
  // The app-managed Desktop profile must never need the npm plugin manager.
  writeFileSync(join(f.temp, 'bin/pnpm'), `#!${process.execPath}\nprocess.exit(1);\n`, { mode: 0o755 });

  const result = f.cli('setup', '--agents', 'dsh', '--dsh-profile', 'desktop', '--source', f.source);
  good(result);
  assert.match(result.stdout, /global-only; managed by the Desktop app/);
  assert.match(result.stdout, /use --dsh-profile web/);
  assert.doesNotMatch(result.stdout, /Connect native Kitto integrations/);
  assert.match(result.stderr, /has not been initialized/);
  assert.match(readFileSync(join(f.env.DSH_HOME, 'AGENTS.md'), 'utf8'), /Desktop portable rules/);
  assert.equal(readFileSync(join(f.env.DSH_HOME, 'skills/desktop-example/SKILL.md'), 'utf8'), 'Desktop host skill');
  assert.match(readFileSync(join(f.env.PI_AGENTS_DIR, 'skills/example/SKILL.md'), 'utf8'), /Example body/);
  assert.equal(readJson(join(f.env.KITTO_HOME, 'state.json')).dshProfile, 'desktop');
  assert.equal(existsSync(join(f.env.DSH_HOME, 'profiles/desktop')), false);
  let calls = callsOf(f);
  assert(!calls.some(c => c.command === 'dsh'));
  assert(!calls.some(c => c.command === 'pnpm'));
  const versions = f.maintain('versions');
  good(versions);
  assert.match(versions.stdout, /app-managed/);

  // Removal must not run a native plugin removal for a bundle Kitto never installed.
  good(f.maintain('remove', '--apply'));
  assert.equal(readJson(join(f.env.KITTO_HOME, 'state.json')).detached, true);
  assert.match(readFileSync(join(f.env.DSH_HOME, 'AGENTS.md'), 'utf8'), /Desktop portable rules/);
  calls = callsOf(f);
  assert(!calls.some(c => c.command === 'dsh' && c.args.includes('remove')));
});

test('DSH desktop detection reports an uninitialized profile, the npm CLI and a working in-app CLI', t => {
  const f = fixture(t);
  const profile = join(f.env.DSH_HOME, 'profiles/desktop');
  const args = ['setup', '--agents', 'dsh', '--dsh-profile', 'desktop', '--source', f.source, '--dry-run'];
  const probeCalls = () => callsOf(f).filter(c => c.command === 'dsh' && c.args.includes('version-exemptions'));

  const uninitialized = f.cli(...args);
  good(uninitialized);
  assert.match(uninitialized.stderr, /has not been initialized/);
  assert.match(uninitialized.stderr, /Start DeepSeek Harness Desktop once/);
  assert.doesNotMatch(uninitialized.stdout, /Connect native Kitto integrations/);
  assert.equal(probeCalls().length, 0);
  assert.equal(existsSync(f.env.KITTO_HOME), false);

  mkdirSync(profile, { recursive: true });
  const manifest = { dependencies: {}, dsh: { profile: { bundles: [] } } };
  writeFileSync(join(profile, 'package.json'), JSON.stringify(manifest));
  f.env.FAKE_DSH_CLI = 'npm';
  const npm = f.cli(...args);
  good(npm);
  assert.match(npm.stderr, /npm CLI and cannot manage the desktop profile/);
  assert.doesNotMatch(npm.stderr, /Manage dsh Command/);
  assert.equal(probeCalls().length, 1);

  delete f.env.FAKE_DSH_CLI;
  const ready = f.cli(...args);
  good(ready);
  assert.match(ready.stdout, /initialized profile detected \(probe ran against a temporary copy\)/);
  assert.deepEqual(readJson(join(profile, 'package.json')), manifest);
  assert.deepEqual(readdirSync(profile), ['package.json']);
  assert.equal(probeCalls().length, 2);
});

test('DSH desktop setup skips CLI checks and never installs the npm dsh CLI', t => {
  const f = fixture(t);
  const bin = join(f.temp, 'bin');
  const git = command('which', ['git'], f.env).stdout.trim();
  rmSync(join(bin, 'dsh'));
  symlinkSync(git, join(bin, 'git'));
  f.env.PATH = bin;
  const profile = join(f.env.DSH_HOME, 'profiles/desktop');
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: [] } } }));
  mkdirSync(join(f.source, 'config/dsh'), { recursive: true });
  writeFileSync(join(f.source, 'config/dsh/AGENTS.md'), 'Desktop portable rules');
  const npm = join(bin, 'npm');
  writeFileSync(npm, `#!${process.execPath}\nrequire('node:fs').appendFileSync(process.env.CALL_LOG, JSON.stringify({ command: 'npm', args: process.argv.slice(2) }) + '\\n');\n`, { mode: 0o755 });

  const result = f.cli('setup', '--agents', 'dsh', '--dsh-profile', 'Desktop', '--source', f.source, '--install-agents');
  good(result);
  assert.equal(readJson(join(f.env.KITTO_HOME, 'state.json')).dshProfile, 'desktop');
  assert.match(result.stderr, /No dsh CLI was found on PATH/);
  assert.match(readFileSync(join(f.env.DSH_HOME, 'AGENTS.md'), 'utf8'), /Desktop portable rules/);
  assert.deepEqual(readdirSync(profile), ['package.json']);
  const calls = callsOf(f);
  assert(!calls.some(c => c.command === 'npm' || c.command === 'dsh'));
});

test('DSH desktop probe copies the profile, tolerates a read-only home and reports timeouts', t => {
  const f = fixture(t);
  const profile = join(f.env.DSH_HOME, 'profiles/desktop');
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: [] } } }));

  assert.equal(probeDesktopProfile({ dshHome: f.env.DSH_HOME, env: f.env }).kind, 'desktop-cli');
  assert.deepEqual(readdirSync(profile), ['package.json']);

  chmodSync(profile, 0o555);
  try {
    assert.equal(probeDesktopProfile({ dshHome: f.env.DSH_HOME, env: f.env }).kind, 'desktop-cli');
    assert.deepEqual(readdirSync(profile), ['package.json']);
  } finally { chmodSync(profile, 0o755); }

  f.env.FAKE_DSH_PROBE_DELAY_MS = '1000';
  assert.equal(probeDesktopProfile({ dshHome: f.env.DSH_HOME, env: f.env, timeoutMs: 150 }).kind, 'timeout');
  delete f.env.FAKE_DSH_PROBE_DELAY_MS;
  assert.deepEqual(readdirSync(profile), ['package.json']);
});

test('shared-rules-only setup is rejected for the DSH desktop profile', t => {
  const f = fixture(t);
  const result = command(process.execPath, ['--input-type=module', '-e',
    `import { runEnvironmentSetup } from './lib/environment-setup.mjs';
     await runEnvironmentSetup(${JSON.stringify({ agents: ['dsh'], source: false, installAgents: false,
       deps: false, dshProfile: 'desktop', dryRun: true })});`,
  ], f.env);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires a configuration source/);
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

test('guided setup keeps divergent unowned skills through later Pi syncs', t => {
  const f = fixture(t);
  const local = join(f.env.PI_AGENTS_DIR, 'skills/example');
  const owned = join(f.env.PI_AGENTS_DIR, 'skills/managed/SKILL.md');
  const source = join(f.source, 'skills/example/SKILL.md');
  const hostLocal = join(f.env.PI_CODING_AGENT_DIR, 'skills/host-example');
  const hostSource = join(f.source, 'config/pi/skills/host-example');
  const state = join(f.env.KITTO_HOME, 'state.json');
  for (const dir of [local, hostSource, join(f.source, 'skills/managed')]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(local, 'SKILL.md'), 'local shared skill');
  writeFileSync(join(f.source, 'skills/managed/SKILL.md'), 'managed skill');
  writeFileSync(join(hostSource, 'SKILL.md'), 'host skill from source');
  mkdirSync(join(f.env.PI_CODING_AGENT_DIR, 'skills'), { recursive: true });
  symlinkSync(local, hostLocal, 'dir');

  const setup = command(process.execPath, ['--input-type=module', '-e',
    `import { setup } from './lib/kitto.mjs';
     await setup(${JSON.stringify({ source: f.source, agents: ['pi'], keepExistingSkills: true })});`,
  ], f.env);
  good(setup);
  assert.match(setup.stdout, /skill keep: example \(shared\)/);
  assert.equal(readFileSync(join(local, 'SKILL.md'), 'utf8'), 'local shared skill');
  assert.equal(readJson(state).keepExistingSkills, true);
  assert.deepEqual(readJson(state).keptSkills, { shared: ['example'], pi: ['host-example'] });
  assert.deepEqual(Object.keys(readJson(state).skills), ['managed']);

  // A removed source must not remove the local copy or forget its ownership.
  rmSync(source);
  good(f.maintain('sync', '--apply'));
  assert.deepEqual(readJson(state).keptSkills.shared, ['example']);
  // A source that briefly matches still cannot turn the local skill into a managed copy.
  writeFileSync(source, 'local shared skill');
  good(f.maintain('sync', '--apply'));
  assert.deepEqual(Object.keys(readJson(state).skills), ['managed']);
  writeFileSync(source, 'new source body');
  good(f.maintain('sync', '--apply'));
  assert.equal(readFileSync(join(local, 'SKILL.md'), 'utf8'), 'local shared skill');
  assert.equal(readFileSync(join(hostLocal, 'SKILL.md'), 'utf8'), 'local shared skill');
  writeFileSync(owned, 'local edit of managed skill');
  assert.match(f.maintain('sync', '--apply').stderr, /Skill conflict/);
  assert.equal(readFileSync(owned, 'utf8'), 'local edit of managed skill');
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

test('kitto update refreshes the runtime copy, deploys the new source and records a checkpoint', async t => {
  const f = fixture(t), a = release(f, '0.1.0-test.1'), b = release(f, '0.1.0-test.2', 'update');
  good(a('--agents', 'codex', '--source', f.source));
  const home = f.env.KITTO_HOME, runtime = join(home, 'runtime'), statePath = join(home, 'state.json');
  const skill = join(f.env.PI_AGENTS_DIR, 'skills/example/SKILL.md');
  assert.equal(readJson(join(runtime, 'package.json')).version, '0.1.0-test.1');
  assert.equal(readJson(statePath).version, '0.1.0-test.1');
  withRemote(f);
  writeFileSync(join(f.source, 'skills/example/SKILL.md'), 'updated by kitto update');
  commitAll(f, 'release config');
  good(command('git', ['push', 'origin', 'main'], f.env, f.source));
  const revision = command('git', ['rev-parse', 'HEAD'], f.env, f.source).stdout.trim();
  const deployed = readJson(statePath).deployed;
  const skillBefore = readFileSync(skill, 'utf8');
  const before = snapshot(home);

  const preview = b('--check');
  good(preview);
  assert.match(preview.stdout, /Runtime: 0\.1\.0-test\.1 -> 0\.1\.0-test\.2/);
  assert.match(preview.stdout, /Preview only/);
  assert.deepEqual(snapshot(home), before);

  good(b('--apply'));
  assert.equal(readJson(join(runtime, 'package.json')).version, '0.1.0-test.2');
  assert.notEqual(skillBefore, readFileSync(skill, 'utf8'));
  assert.equal(readFileSync(skill, 'utf8'), 'updated by kitto update');
  const state = readJson(statePath);
  assert.equal(state.version, '0.1.0-test.2');
  assert.equal(state.deployed.commit, revision);
  assert.equal(state.runtimeHash, await treeHash(runtime, true));
  assert.equal(state.pendingRuntime, undefined);
  assert.notEqual(deployed.commit, state.deployed.commit);
  const checkpoint = readJson(join(home, 'runtime.previous.json'));
  assert.equal(checkpoint.version, '0.1.0-test.1');
  assert.equal(checkpoint.hash, await treeHash(join(home, 'runtime.previous'), true));
  assert(existsSync(join(home, 'runtime.previous/lib/kitto.mjs')));
  // The refreshed copy is what later Kitto calls use; it cannot replace itself.
  // Semantics: report the installed version, never a version bump, and write nothing.
  const installed = snapshot(home);
  const refreshed = command(process.execPath, [join(runtime, 'bin/kitto.mjs'), 'update', '--check'], f.env);
  good(refreshed);
  assert.match(refreshed.stdout, /Runtime: 0\.1\.0-test\.2 \(this entry runs from the installed copy/);
  assert.doesNotMatch(refreshed.stdout, /Runtime: 0\.1\.0-test\.2 ->/);
  assert.deepEqual(snapshot(home), installed);
  good(f.maintain('status'));
});

test('a failed deployment after the runtime swap is not verified and stays recoverable', t => {
  const f = fixture(t), a = release(f, '0.1.0-test.1'), b = release(f, '0.1.0-test.2', 'update');
  good(a('--agents', 'codex', '--source', f.source));
  const home = f.env.KITTO_HOME, statePath = join(home, 'state.json'), runtime = join(home, 'runtime');
  const verifiedHash = readJson(statePath).runtimeHash;
  withRemote(f);
  writeFileSync(join(f.source, 'config/pi/mcp.json'), JSON.stringify({ mcpServers: { debug: { command: 'debug-mcp' } } }));
  commitAll(f, 'add mcp server');
  good(command('git', ['push', 'origin', 'main'], f.env, f.source));
  f.env.FAKE_MCP_FAIL_ADD = 'debug';
  const failed = b('--apply');
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /simulated MCP add failure/);
  // The new runtime is active but not verified: state still names the old one.
  assert.equal(readJson(join(runtime, 'package.json')).version, '0.1.0-test.2');
  let state = readJson(statePath);
  assert.equal(state.version, '0.1.0-test.1');
  assert.equal(state.runtimeHash, verifiedHash);
  assert.equal(state.pendingRuntime.version, '0.1.0-test.2');
  assert.equal(readJson(join(home, 'runtime.previous.json')).version, '0.1.0-test.1');
  good(f.cli('setup', '--recover', '--dry-run'));
  delete f.env.FAKE_MCP_FAIL_ADD;
  good(f.cli('setup', '--recover'));
  state = readJson(join(statePath));
  assert.equal(readJson(join(runtime, 'package.json')).version, '0.1.0-test.1');
  assert.equal(state.version, '0.1.0-test.1');
  assert.equal(state.pendingRuntime, undefined);
  assert.equal(state.ready, true);
});

test('a failed update is never checkpointed and a later update keeps the real checkpoint', t => {
  const f = fixture(t), a = release(f, '0.1.0-test.1'), b = release(f, '0.1.0-test.2', 'update'), c = release(f, '0.1.0-test.3', 'update');
  good(a('--agents', 'codex', '--source', f.source));
  const home = f.env.KITTO_HOME, statePath = join(home, 'state.json');
  withRemote(f);
  writeFileSync(join(f.source, 'config/pi/mcp.json'), JSON.stringify({ mcpServers: { debug: { command: 'debug-mcp' } } }));
  commitAll(f, 'add mcp server');
  good(command('git', ['push', 'origin', 'main'], f.env, f.source));
  f.env.FAKE_MCP_FAIL_ADD = 'debug';
  assert.notEqual(b('--apply').status, 0);
  assert.equal(readJson(join(home, 'runtime.previous.json')).version, '0.1.0-test.1');
  delete f.env.FAKE_MCP_FAIL_ADD;
  // Without the pending marker, this would checkpoint the never-deployed B runtime.
  good(c('--apply'));
  const state = readJson(statePath);
  assert.equal(state.version, '0.1.0-test.3');
  assert.equal(state.pendingRuntime, undefined);
  assert.equal(readJson(join(home, 'runtime.previous.json')).version, '0.1.0-test.1');
  good(f.cli('setup', '--recover'));
  assert.equal(readJson(join(home, 'runtime/package.json')).version, '0.1.0-test.1');
  assert.equal(readJson(statePath).version, '0.1.0-test.1');
});

test('an installRuntime failure leaves the verified runtime and state intact', t => {
  const f = fixture(t), a = release(f, '0.1.0-test.1'), b = release(f, '0.1.0-test.2', 'update');
  good(a('--agents', 'codex', '--source', f.source));
  const home = f.env.KITTO_HOME, runtime = join(home, 'runtime'), statePath = join(home, 'state.json');
  withRemote(f);
  const stateBefore = readFileSync(statePath, 'utf8');
  // The copy stage fails after some files were staged; the live runtime is untouched.
  rmSync(join(f.temp, '0.1.0-test.2/CHANGELOG.md'));
  assert.notEqual(b('--apply').status, 0);
  assert.equal(readJson(join(runtime, 'package.json')).version, '0.1.0-test.1');
  assert.equal(readFileSync(statePath, 'utf8'), stateBefore);
  assert.equal(existsSync(join(home, 'runtime.previous.json')), false);
  assert.equal(existsSync(join(home, '.lock')), false);
  cpSync(join(root, 'CHANGELOG.md'), join(f.temp, '0.1.0-test.2/CHANGELOG.md'));
  good(b('--apply'));
  assert.equal(readJson(join(runtime, 'package.json')).version, '0.1.0-test.2');
  assert.equal(readJson(statePath).version, '0.1.0-test.2');
});

test('maintain update fast-forwards and redeploys without replacing its own runtime', t => {
  const f = fixture(t), a = release(f, '0.1.0-test.1');
  good(a('--agents', 'codex', '--source', f.source));
  const home = f.env.KITTO_HOME, runtime = join(home, 'runtime');
  withRemote(f);
  writeFileSync(join(f.source, 'skills/example/SKILL.md'), 'maintain update content');
  commitAll(f, 'maintain config');
  good(command('git', ['push', 'origin', 'main'], f.env, f.source));
  // Preview from the bundled runner must report the installed version and not write.
  const before = snapshot(home);
  const preview = f.maintain('update');
  good(preview);
  assert.match(preview.stdout, /Runtime: 0\.1\.0-test\.1 \(this entry runs from the installed copy/);
  assert.doesNotMatch(preview.stdout, /Runtime: 0\.1\.0-test\.1 ->/);
  assert.deepEqual(snapshot(home), before);
  assert.equal(readJson(join(runtime, 'package.json')).version, '0.1.0-test.1');
  good(f.maintain('update', '--apply'));
  assert.match(readJson(join(home, 'state.json')).deployed.commit, /./);
  assert.equal(readFileSync(join(f.env.PI_AGENTS_DIR, 'skills/example/SKILL.md'), 'utf8'), 'maintain update content');
  assert.equal(readJson(join(runtime, 'package.json')).version, '0.1.0-test.1');
  assert.equal(readJson(join(home, 'state.json')).version, '0.1.0-test.1');
});

test('the installed runtime is recognized through a symlinked KITTO_HOME', t => {
  // macOS resolves /var through /private/var (and users symlink their home), so
  // the runtime identity check must compare realpaths, not the spelling used to
  // launch the entry point.
  const f = fixture(t);
  const alias = join(f.temp, 'home-alias');
  symlinkSync(f.home, alias, 'dir');
  f.env.KITTO_HOME = join(alias, 'kitto');
  good(f.cli('setup', '--agents', 'codex', '--source', f.source));
  withRemote(f);
  const version = readJson(join(root, 'package.json')).version;
  const home = join(f.home, 'kitto'), runtime = join(alias, 'kitto', 'runtime');
  const before = snapshot(home);
  const preview = command(process.execPath, [join(runtime, 'bin/kitto.mjs'), 'update', '--check'], f.env);
  good(preview);
  assert(preview.stdout.includes(`Runtime: ${version} (this entry runs from the installed copy`));
  assert.doesNotMatch(preview.stdout, new RegExp(`Runtime: ${version.replaceAll('.', '\\.')} ->`));
  assert.deepEqual(snapshot(home), before);

  const applied = command(process.execPath, [join(runtime, 'bin/maintain.mjs'), 'update', '--apply'], f.env);
  good(applied);
  assert.match(applied.stdout, /cannot replace itself/);
  assert.equal(readJson(join(home, 'state.json')).version, version);
  assert.equal(readJson(join(home, 'runtime/package.json')).version, version);
});

test('update preview covers the app-managed DSH desktop branch without a dsh CLI', t => {
  const f = fixture(t);
  // The Desktop profile must need no dsh CLI at all, including during update.
  rmSync(join(f.temp, 'bin/dsh'));
  mkdirSync(join(f.source, 'config/dsh'), { recursive: true });
  writeFileSync(join(f.source, 'config/dsh/AGENTS.md'), 'Desktop portable rules');
  commitAll(f, 'desktop rules');
  good(f.cli('setup', '--agents', 'dsh', '--dsh-profile', 'desktop', '--source', f.source));
  withRemote(f);
  const home = f.env.KITTO_HOME;
  const logBefore = existsSync(f.log) ? readFileSync(f.log, 'utf8') : '';
  const before = snapshot(home);
  const preview = f.cli('update', '--check');
  good(preview);
  assert.match(preview.stdout, /dsh: app-managed .*upgrade through DeepSeek Harness Desktop/);
  assert.match(preview.stdout, /Preview only/);
  assert.deepEqual(snapshot(home), before);
  assert.equal(existsSync(f.log) ? readFileSync(f.log, 'utf8') : '', logBefore);
});

test('kitto update restores a lost managed checkout from the recorded source URL', t => {
  const f = fixture(t), { url } = mirrorOf(f);
  good(f.cli('setup', '--agents', 'codex', '--source', url, '--ref', 'main'));
  const home = f.env.KITTO_HOME, managed = join(home, 'config');
  assert.equal(readJson(join(home, 'state.json')).sourceUrl, url);
  assert.equal(readJson(join(home, 'state.json')).sourceRef, 'main');
  writeFileSync(join(f.source, 'skills/example/SKILL.md'), 'restored from source URL');
  commitAll(f, 'remote update');
  good(command('git', ['push', join(f.temp, 'remote.git'), 'main'], f.env, f.source));
  rmSync(managed, { recursive: true });

  const preview = f.cli('update', '--check');
  good(preview);
  assert(preview.stdout.includes(`Restore configuration checkout from ${url} (main): ${managed}`));
  assert.equal(existsSync(managed), false);

  good(f.cli('update', '--apply'));
  assert.equal(existsSync(join(managed, '.git')), true);
  assert.equal(readJson(join(home, 'state.json')).sourceUrl, url);
  assert.equal(readFileSync(join(f.env.PI_AGENTS_DIR, 'skills/example/SKILL.md'), 'utf8'), 'restored from source URL');
  assert.equal(command('git', ['rev-parse', 'HEAD'], f.env, managed).stdout.trim(),
    command('git', ['rev-parse', 'main'], f.env, join(f.temp, 'remote.git')).stdout.trim());
});

test('kitto update restores a lost checkout on its recorded non-default branch', t => {
  const f = fixture(t);
  const git = (...args) => command('git', args, f.env, f.source);
  good(git('checkout', '-b', 'alt'));
  writeFileSync(join(f.source, 'skills/example/SKILL.md'), 'alt branch content');
  commitAll(f, 'alt config');
  good(git('checkout', 'main'));
  const { mirror, url } = mirrorOf(f);
  good(f.cli('setup', '--agents', 'codex', '--source', url, '--ref', 'alt'));
  const home = f.env.KITTO_HOME, managed = join(home, 'config'), statePath = join(home, 'state.json');
  assert.equal(readJson(statePath).sourceRef, 'alt');
  assert.equal(command('git', ['symbolic-ref', '--short', 'HEAD'], f.env, managed).stdout.trim(), 'alt');
  assert.equal(readFileSync(join(f.env.PI_AGENTS_DIR, 'skills/example/SKILL.md'), 'utf8'), 'alt branch content');
  rmSync(managed, { recursive: true });

  const preview = f.cli('update', '--check');
  good(preview);
  assert(preview.stdout.includes(`Restore configuration checkout from ${url} (alt): ${managed}`));
  assert.equal(existsSync(managed), false);
  good(f.cli('update', '--apply'));
  assert.equal(command('git', ['symbolic-ref', '--short', 'HEAD'], f.env, managed).stdout.trim(), 'alt');
  assert.equal(command('git', ['rev-parse', 'HEAD'], f.env, managed).stdout.trim(),
    command('git', ['rev-parse', 'alt'], f.env, mirror).stdout.trim());
  assert.equal(readFileSync(join(f.env.PI_AGENTS_DIR, 'skills/example/SKILL.md'), 'utf8'), 'alt branch content');
  assert.equal(readJson(statePath).sourceRef, 'alt');
});

test('kitto update refuses to guess a lost checkout pinned to a tag', t => {
  const f = fixture(t);
  const git = (...args) => command('git', args, f.env, f.source);
  good(git('tag', 'v1'));
  const { url } = mirrorOf(f);
  good(f.cli('setup', '--agents', 'codex', '--source', url, '--ref', 'v1'));
  const home = f.env.KITTO_HOME, managed = join(home, 'config'), statePath = join(home, 'state.json');
  assert.equal(readJson(statePath).sourceRef, 'v1');
  assert.equal(readJson(statePath).deployed.detached, true);
  writeFileSync(join(f.source, 'skills/example/SKILL.md'), 'default branch moved on');
  commitAll(f, 'main update');
  good(command('git', ['push', join(f.temp, 'remote.git'), 'main'], f.env, f.source));
  rmSync(managed, { recursive: true });

  const refused = f.cli('update', '--apply');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /pinned to a detached revision \(v1\)/);
  assert.match(refused.stderr, /rerun kitto setup/);
  assert.match(refused.stderr, /new KITTO_HOME/);
  assert.equal(existsSync(managed), false);

  // Without a recorded detached deployment, preview and apply must agree: both
  // inspect the recorded ref and refuse to guess a tag.
  const state = readJson(statePath);
  delete state.deployed;
  writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
  for (const args of [['update', '--check'], ['update', '--apply']]) {
    const detected = f.cli(...args);
    assert.notEqual(detected.status, 0);
    assert.match(detected.stderr, /pinned to tag v1/);
    assert.match(detected.stderr, /git -C '.*' checkout 'v1'/);
    assert.doesNotMatch(detected.stdout, /Restore configuration checkout/);
    assert.equal(existsSync(managed), false);
  }
});

test('kitto update backfills a missing sourceUrl and sourceRef from the bootstrap marker', t => {
  const f = fixture(t), { url } = mirrorOf(f);
  good(f.cli('setup', '--agents', 'codex', '--source', url, '--ref', 'main'));
  const home = f.env.KITTO_HOME, managed = join(home, 'config'), statePath = join(home, 'state.json');
  const legacy = readJson(statePath);
  delete legacy.sourceUrl;
  delete legacy.sourceRef;
  writeFileSync(statePath, JSON.stringify(legacy, null, 2) + '\n');

  const preview = f.cli('update', '--check');
  good(preview);
  assert.match(preview.stdout, /Recovered the configuration source from the bootstrap marker/);
  assert.equal(readJson(statePath).sourceUrl, undefined); // preview never writes
  good(f.cli('update', '--apply'));
  assert.equal(readJson(statePath).sourceUrl, url);
  assert.equal(readJson(statePath).sourceRef, 'main');

  // The backfilled values make a later lost-checkout recovery possible.
  rmSync(managed, { recursive: true });
  good(f.cli('update', '--apply'));
  assert.equal(existsSync(join(managed, '.git')), true);
  assert.equal(readJson(statePath).sourceUrl, url);
});

test('kitto update refuses a lost checkout whose recorded ref is unknown or not a Git URL', t => {
  const f = fixture(t), { url } = mirrorOf(f);
  good(f.cli('setup', '--agents', 'codex', '--source', url, '--ref', 'main'));
  const home = f.env.KITTO_HOME, managed = join(home, 'config'), statePath = join(home, 'state.json');
  const legacy = readJson(statePath);
  delete legacy.sourceRef;
  writeFileSync(statePath, JSON.stringify(legacy, null, 2) + '\n');
  rmSync(managed, { recursive: true });

  const unknown = f.cli('update', '--apply');
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /does not record its branch or tag/);
  assert.match(unknown.stderr, /new KITTO_HOME/);
  assert.equal(existsSync(managed), false);

  const state = readJson(statePath);
  state.sourceRef = 'main';
  state.sourceUrl = '/tmp/local-config';
  writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
  const scheme = f.cli('update', '--apply');
  assert.notEqual(scheme.status, 0);
  assert.match(scheme.stderr, /not an HTTPS\/SSH Git URL/);
  assert.equal(existsSync(managed), false);
});

test('kitto update follows a changed origin and redacts credentials in messages', t => {
  const f = fixture(t), first = 'https://kitto.invalid/config.git', second = 'https://user:secret@kitto.invalid/config2.git';
  const { mirror } = mirrorOf(f, first, second);
  good(f.cli('setup', '--agents', 'codex', '--source', first, '--ref', 'main'));
  const home = f.env.KITTO_HOME, managed = join(home, 'config'), statePath = join(home, 'state.json');
  assert.equal(readJson(statePath).sourceUrl, first);
  good(command('git', ['remote', 'set-url', 'origin', second], f.env, managed));

  const preview = f.cli('update', '--check');
  good(preview);
  assert.match(preview.stdout, /source URL changed: https:\/\/kitto\.invalid\/config\.git -> https:\/\/\*\*\*@kitto\.invalid\/config2\.git/);
  assert.doesNotMatch(preview.stdout, /secret/);
  assert.equal(readJson(statePath).sourceUrl, first); // preview never writes

  good(f.cli('update', '--apply'));
  assert.equal(readJson(statePath).sourceUrl, second);
  assert.equal(readJson(bootstrapMarkerFor(managed)).url, second);

  // Recovery now clones through the updated URL, not the stale one.
  rmSync(managed, { recursive: true });
  good(f.cli('update', '--apply'));
  assert.equal(existsSync(join(managed, '.git')), true);
  assert.equal(readJson(statePath).sourceUrl, second);
  assert.equal(command('git', ['rev-parse', 'HEAD'], f.env, managed).stdout.trim(),
    command('git', ['rev-parse', 'main'], f.env, mirror).stdout.trim());
});

test('kitto update explains a missing upstream and refuses a diverged remote', t => {
  const f = fixture(t);
  good(f.cli('setup', '--agents', 'codex', '--source', f.source));
  const statePath = join(f.env.KITTO_HOME, 'state.json'), stateBefore = readFileSync(statePath, 'utf8');
  for (const args of [['update'], ['update', '--apply']]) {
    const result = f.cli(...args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /has no upstream/);
    assert.match(result.stderr, /--set-upstream-to/);
  }
  assert.equal(readFileSync(statePath, 'utf8'), stateBefore);

  withRemote(f);
  writeFileSync(join(f.source, 'local-only.txt'), 'local');
  commitAll(f, 'local commit');
  const other = join(f.temp, 'other');
  good(command('git', ['clone', join(f.temp, 'remote.git'), other], f.env));
  for (const args of [['config', 'user.email', 'test@example.invalid'], ['config', 'user.name', 'Test']]) good(command('git', args, f.env, other));
  writeFileSync(join(other, 'remote-only.txt'), 'remote');
  for (const args of [['add', '.'], ['commit', '-m', 'remote commit'], ['push', 'origin', 'main']]) good(command('git', args, f.env, other));
  const head = command('git', ['rev-parse', 'HEAD'], f.env, f.source).stdout;
  const diverged = f.cli('update', '--apply');
  assert.notEqual(diverged.status, 0);
  assert.match(diverged.stderr, /have diverged/);
  assert.match(diverged.stderr, /neither is an ancestor/);
  assert.equal(command('git', ['rev-parse', 'HEAD'], f.env, f.source).stdout, head);
});

test('kitto update allows a clean local branch that is ahead of its remote', t => {
  const f = fixture(t);
  good(f.cli('setup', '--agents', 'codex', '--source', f.source));
  withRemote(f);
  writeFileSync(join(f.source, 'local-note.txt'), 'local work');
  commitAll(f, 'local ahead');
  const head = command('git', ['rev-parse', 'HEAD'], f.env, f.source).stdout.trim();
  const statePath = join(f.env.KITTO_HOME, 'state.json');

  // A local-only commit must not be mistaken for a diverged remote.
  const preview = f.cli('update', '--check');
  good(preview);
  assert.doesNotMatch(preview.stdout + preview.stderr, /diverged/);
  const applied = f.cli('update', '--apply');
  good(applied);
  assert.doesNotMatch(applied.stdout + applied.stderr, /diverged/);
  assert.match(applied.stdout, /is already at/);
  assert.equal(command('git', ['rev-parse', 'HEAD'], f.env, f.source).stdout.trim(), head);
  assert.equal(readJson(statePath).deployed.commit, head);
});

test('kitto update preview writes neither the home, the source nor the deployment', t => {
  const f = fixture(t);
  good(f.cli('setup', '--agents', 'codex', '--source', f.source));
  withRemote(f);
  writeFileSync(join(f.source, 'skills/example/SKILL.md'), 'new remote skill');
  commitAll(f, 'remote update');
  good(command('git', ['push', 'origin', 'main'], f.env, f.source));
  const home = f.env.KITTO_HOME, skill = join(f.env.PI_AGENTS_DIR, 'skills/example/SKILL.md');
  const before = snapshot(home), skillBefore = readFileSync(skill, 'utf8');
  const head = command('git', ['rev-parse', 'HEAD'], f.env, f.source).stdout;

  const preview = f.cli('update');
  good(preview);
  assert.match(preview.stdout, /Configuration main: local/);
  assert.match(preview.stdout, /Preview only/);
  assert.deepEqual(snapshot(home), before);
  assert.equal(readFileSync(skill, 'utf8'), skillBefore);
  assert.equal(command('git', ['rev-parse', 'HEAD'], f.env, f.source).stdout, head);
  assert.equal(existsSync(join(home, '.lock')), false);
});

test('kitto update tolerates state from an older version and explains a missing local checkout', t => {
  const f = fixture(t);
  good(f.cli('setup', '--agents', 'codex', '--source', f.source));
  const statePath = join(f.env.KITTO_HOME, 'state.json');
  // A user-owned checkout has no recoverable URL, matching older state files.
  assert.equal(readJson(statePath).sourceUrl, undefined);
  assert.equal(readJson(statePath).sourceRef, null);
  withRemote(f);
  const legacy = readJson(statePath);
  delete legacy.sourceUrl;
  delete legacy.sourceRef;
  delete legacy.pendingRuntime;
  writeFileSync(statePath, JSON.stringify(legacy, null, 2) + '\n');
  const preview = f.cli('update', '--check');
  good(preview);
  assert.match(preview.stdout, /update preview \(no writes\)/);
  good(f.cli('update', '--apply'));
  rmSync(f.source, { recursive: true });
  const lost = f.cli('update', '--apply');
  assert.notEqual(lost.status, 0);
  assert.match(lost.stderr, /no source URL was recorded/);
  assert.match(lost.stderr, /or use a new KITTO_HOME/);
  assert.equal(existsSync(join(f.env.KITTO_HOME, 'config')), false);
});

test('kitto update refuses dirty worktrees and pinned tag checkouts before writing', t => {
  const f = fixture(t);
  good(f.cli('setup', '--agents', 'codex', '--source', f.source));
  const statePath = join(f.env.KITTO_HOME, 'state.json'), before = readFileSync(statePath, 'utf8');
  writeFileSync(join(f.source, 'uncommitted.txt'), 'work');
  const dirty = f.cli('update', '--apply');
  assert.notEqual(dirty.status, 0);
  assert.match(dirty.stderr, /local changes/);
  assert.equal(readFileSync(join(f.source, 'uncommitted.txt'), 'utf8'), 'work');
  assert.equal(readFileSync(statePath, 'utf8'), before);
  rmSync(join(f.source, 'uncommitted.txt'));
  good(command('git', ['tag', 'v1'], f.env, f.source));
  good(command('git', ['checkout', '--detach', 'v1'], f.env, f.source));
  assert.match(f.cli('update', '--apply').stderr, /pinned to a detached revision/);
  assert.match(f.cli('update', '--check').stderr, /pinned to a detached revision/);
  assert.equal(readFileSync(statePath, 'utf8'), before);
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
  test(`${agent}-only setup, sync and versions work without unneeded Pi files, Bash or Python`, t => {
    const f = fixture(t);
    if (agent === 'codex') {
      // Codex MCP sync reads the Pi MCP source, but no Pi settings, rules or tools.
      for (const name of ['settings.json', 'AGENTS.md', 'i-have-adhd-always']) rmSync(join(f.source, `config/pi/${name}`));
    } else rmSync(join(f.source, 'config/pi'), { recursive: true });
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
    assert.match(readFileSync(instructions, 'utf8'), /My local rules\n[\s\S]*Portable rules/);
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
    assert.match(readFileSync(instructions, 'utf8'), /My local rules\n[\s\S]*Updated portable rules/);
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
  const homeAlias = join(f.temp, 'home-alias');
  symlinkSync(f.home, homeAlias, 'dir');
  f.env.KITTO_HOME = join(homeAlias, 'kitto');
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

test('interactive CLI previews and applies bundled Pi and Codex setup for future workspaces', async t => {
  const { realpath } = await import('node:fs/promises');
  const f = fixture(t);
  const workspaceParent = join(await realpath(f.temp), 'workspaces');
  const result = spawnSync(process.execPath, [join(root, 'bin/kitto.mjs'), 'setup', '--interactive'], {
    env: f.env,
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
    input: ['pi,codex', '2', f.source, 'n', workspaceParent, '1', '2', ''].join('\n'),
  });
  good(result);
  assert.match(result.stdout, /安装计划[\s\S]*Preview only[\s\S]*预览完成[\s\S]*Scope ready/);
  const state = readJson(join(f.env.KITTO_HOME, 'state.json'));
  assert.equal(state.ready, true);
  assert.deepEqual(state.agents, ['pi', 'codex']);
  assert.equal(state.source, await realpath(f.source));
  assert.equal(readFileSync(join(f.env.PI_AGENTS_DIR, 'skills/example/SKILL.md'), 'utf8'),
    readFileSync(join(f.source, 'skills/example/SKILL.md'), 'utf8'));
  assert.equal(existsSync(join(f.env.PI_CODING_AGENT_DIR, 'mcp.json')), true);
  const calls = readFileSync(f.log, 'utf8').trim().split('\n').map(JSON.parse);
  assert(calls.some(c => c.command === 'pi' && c.args[0] === 'install'));
  assert(calls.some(c => c.command === 'codex' && c.args.join(' ') === 'plugin add kitto@phyzess-kitto'));

  const registry = readJson(join(f.env.KITTO_HOME, 'scopes.json'));
  assert.equal(registry.global, true);
  assert.deepEqual(registry.workspaceParents, [workspaceParent]);
  const workspace = join(workspaceParent, 'future-team');
  const project = join(workspace, 'repo');
  const skills = join(workspace, '.agents', 'skills');
  const skillName = 'future-workspace-skill';
  mkdirSync(join(skills, skillName), { recursive: true });
  writeFileSync(join(skills, skillName, 'SKILL.md'), `---\nname: ${skillName}\ndescription: Fixture skill\n---\nSkill body\n`);
  writeFileSync(join(workspace, 'AGENTS.md'), 'Future workspace instructions');
  good(command('git', ['clone', '-q', f.source, project], f.env));

  const nativeEnv = { ...f.env };
  delete nativeEnv.KITTO_HOME;
  const extension = join(f.env.PI_CODING_AGENT_DIR, 'extensions/kitto-scopes.js');
  const pi = command(process.execPath, ['--input-type=module', '-e', `
    const handlers = new Map();
    const extension = await import(process.argv[1]);
    extension.default({ on: (event, handler) => handlers.set(event, handler) });
    const cwd = process.cwd();
    const contextFiles = [];
    await handlers.get('before_agent_start')({ systemPromptOptions: { contextFiles } }, { cwd });
    const { skillPaths } = await handlers.get('resources_discover')({ cwd });
    console.log(JSON.stringify({ contextFiles, skillPaths }));
  `, extension], nativeEnv, project);
  good(pi);
  const { contextFiles, skillPaths } = JSON.parse(pi.stdout);
  assert(contextFiles.some(file => file.content === 'Future workspace instructions'));
  assert(skillPaths.includes(skills));

  const hooks = readJson(join(f.env.CODEX_HOME, 'hooks.json'));
  const hook = hooks.hooks.SessionStart[0].hooks[0].command;
  const codex = spawnSync('sh', ['-c', hook], {
    cwd: project, env: nativeEnv, encoding: 'utf8', timeout: 8_000,
    input: JSON.stringify({ cwd: project }),
  });
  good(codex);
  const { additionalContext } = JSON.parse(codex.stdout).hookSpecificOutput;
  assert.match(additionalContext, /Future workspace instructions/);
  assert.match(additionalContext, /future-workspace-skill/);
  assert.equal(command('git', ['status', '--porcelain'], f.env, project).stdout, '');
});

test('interactive DSH Desktop setup stays global-only and skips scoped adapters', t => {
  const f = fixture(t);
  mkdirSync(join(f.source, 'config/dsh/skills/desktop-example'), { recursive: true });
  writeFileSync(join(f.source, 'config/dsh/skills/desktop-example/SKILL.md'), 'Desktop host skill');
  writeFileSync(join(f.source, 'config/dsh/AGENTS.md'), 'Desktop portable rules');
  writeFileSync(join(f.temp, 'bin/pnpm'), `#!${process.execPath}\nprocess.exit(1);\n`, { mode: 0o755 });
  const result = spawnSync(process.execPath, [join(root, 'bin/kitto.mjs'), 'setup', '--interactive'], {
    env: f.env, cwd: root, encoding: 'utf8', timeout: 60_000,
    input: ['dsh', 'desktop', '2', f.source, 'n', '', '2'].join('\n'),
  });
  good(result);
  assert.match(result.stdout, /DSH Desktop 由 App 管理/);
  assert.match(result.stdout, /环境配置已完成/);
  assert.doesNotMatch(result.stdout, /Connect native Kitto integrations/);
  assert.doesNotMatch(result.stdout, /DSH scope registration will run/);
  assert.equal(readJson(join(f.env.KITTO_HOME, 'state.json')).dshProfile, 'desktop');
  assert.match(readFileSync(join(f.env.DSH_HOME, 'AGENTS.md'), 'utf8'), /Desktop portable rules/);
  assert.equal(existsSync(join(f.env.KITTO_HOME, 'scopes.json')), false);
  assert.equal(existsSync(join(f.env.DSH_HOME, 'profiles/desktop')), false);
  const calls = readFileSync(f.log, 'utf8').trim().split('\n').map(JSON.parse);
  assert(!calls.some(c => c.command === 'dsh' && c.args.includes('add')));
  assert(!calls.some(c => c.command === 'pnpm'));
});

// A test-local PATH with fake hosts and npm only, so `kitto hosts` cannot reach
// real CLIs or the network. The version file is updated by the fake npm shim.
function hostsTools(f, { versions = {}, missing = [], id = 'hosts-tools' } = {}) {
  const bin = join(f.temp, id);
  mkdirSync(bin, { recursive: true });
  const versionsFile = join(bin, 'versions.json');
  writeFileSync(versionsFile, JSON.stringify(versions));
  const log = join(bin, 'calls.jsonl');
  for (const name of ['npm', 'pi', 'codex', 'dsh']) {
    if (missing.includes(name)) continue;
    writeFileSync(join(bin, name),
      `#!${process.execPath}\nrequire(${JSON.stringify(join(root, 'tests/helpers/fake-hosts-tool.cjs'))});\n`,
      { mode: 0o755 });
  }
  const env = { ...f.env, PATH: bin, HOSTS_VERSIONS: versionsFile, HOSTS_LOG: log };
  const calls = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  return {
    bin, env, log, versionsFile, calls,
    installs: () => calls().filter(call => call.command === 'npm' && call.args[0] === 'install'),
    versions: () => readJson(versionsFile),
    run: (...args) => command(process.execPath, [join(root, 'bin/kitto.mjs'), ...args], env),
  };
}

test('kitto hosts check reports selected versions and baselines without writes', t => {
  const f = fixture(t);
  good(f.cli('setup', '--agents', 'pi,codex', '--source', f.source));
  const tools = hostsTools(f, { versions: { pi: '1.4.0', codex: '0.170.0' } });
  const home = f.env.KITTO_HOME, statePath = join(home, 'state.json');
  const before = snapshot(home), stateBefore = readFileSync(statePath, 'utf8');

  const result = tools.run('hosts');
  good(result);
  assert.match(result.stdout, /host CLIs \(check only; no writes\)/);
  assert.match(result.stdout, /pi: current 1\.4\.0; Kitto baseline 1\.5\.2; target 1\.5\.2; upgrade needed/);
  assert.match(result.stdout, /native manager: npm install --global @earendil-works\/pi-coding-agent@1\.5\.2/);
  assert.match(result.stdout, /codex: current 0\.170\.0; Kitto baseline 0\.170\.0/);
  assert.doesNotMatch(result.stdout, /dsh/);
  assert.equal(tools.installs().length, 0);
  assert.equal(tools.calls().some(call => call.command === 'npm'), false);
  assert.deepEqual(snapshot(home), before);
  assert.equal(readFileSync(statePath, 'utf8'), stateBefore);
  assert.equal(existsSync(join(home, '.lock')), false);

  const explicit = tools.run('hosts', '--check');
  good(explicit);
  assert.match(explicit.stdout, /check only; no writes/);
  assert.equal(tools.installs().length, 0);

  const missingState = { ...tools.env, KITTO_HOME: join(f.temp, 'unset-kitto-home') };
  const notSetup = command(process.execPath, [join(root, 'bin/kitto.mjs'), 'hosts'], missingState);
  assert.notEqual(notSetup.status, 0);
  assert.match(notSetup.stderr, /not set up/);
});

test('kitto hosts --apply installs the exact baseline for outdated selected hosts only', t => {
  const f = fixture(t);
  good(f.cli('setup', '--agents', 'pi,codex', '--source', f.source));
  const tools = hostsTools(f, { versions: { pi: '1.4.0', codex: '0.170.0' } });
  const home = f.env.KITTO_HOME, statePath = join(home, 'state.json');
  const stateBefore = readFileSync(statePath, 'utf8');

  const result = tools.run('hosts', '--apply');
  good(result);
  assert.match(result.stdout, /pi: current 1\.4\.0 -> 1\.5\.2/);
  assert.match(result.stdout, /verified pi 1\.5\.2/);
  assert.deepEqual(tools.installs(),
    [{ command: 'npm', args: ['install', '--global', '@earendil-works/pi-coding-agent@1.5.2'] }]);
  assert.equal(tools.versions().installed['@earendil-works/pi-coding-agent'], '1.5.2');
  assert.equal(tools.versions().installed['@openai/codex'], undefined);
  assert(!tools.calls().some(call => call.command === 'dsh'));
  assert.equal(readFileSync(statePath, 'utf8'), stateBefore);

  const again = tools.run('hosts', '--apply');
  good(again);
  assert.match(again.stdout, /Nothing to change/);
  assert.equal(tools.installs().length, 1);
});

test('kitto hosts --apply keeps a prerelease DSH baseline exact', t => {
  const f = fixture(t);
  good(f.cli('setup', '--agents', 'dsh', '--source', f.source));
  const tools = hostsTools(f, { versions: { dsh: '0.2.2-rc.0' } });
  const result = tools.run('hosts', '--apply');
  good(result);
  assert.deepEqual(tools.installs(),
    [{ command: 'npm', args: ['install', '--global', '@deepseek-ai/dsh@0.2.2-rc.1'] }]);
  assert.match(result.stdout, /verified dsh 0\.2\.2-rc\.1/);
});

test('kitto hosts --version pins one exact version and refuses dist-tags', t => {
  const f = fixture(t);
  good(f.cli('setup', '--agents', 'pi,codex', '--source', f.source));
  const tools = hostsTools(f, { versions: { pi: '1.5.2', codex: '0.170.0' } });

  const pinned = tools.run('hosts', '--host', 'codex', '--version', '0.169.5', '--apply');
  good(pinned);
  assert.match(pinned.stdout, /Explicit pin overrides the Kitto-validated baseline for codex \(0\.170\.0 -> 0\.169\.5\)/);
  assert.match(pinned.stdout, /verified codex 0\.169\.5/);
  assert.deepEqual(tools.installs(),
    [{ command: 'npm', args: ['install', '--global', '@openai/codex@0.169.5'] }]);

  const ambiguous = tools.run('hosts', '--version', '1.5.2');
  assert.notEqual(ambiguous.status, 0);
  assert.match(ambiguous.stderr, /--version pins one host/);
  const rejected = tools.run('hosts', '--version', 'latest');
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /exact semantic version/);
  const unknownHost = tools.run('hosts', '--host', 'dsh');
  assert.notEqual(unknownHost.status, 0);
  assert.match(unknownHost.stderr, /not a selected host/);
  const conflict = tools.run('hosts', '--check', '--apply');
  assert.notEqual(conflict.status, 0);
  assert.match(conflict.stderr, /Choose either --check or --apply/);
});

test('a failed kitto hosts --apply changes neither the host CLI nor Kitto state', t => {
  const f = fixture(t);
  good(f.cli('setup', '--agents', 'pi', '--source', f.source));
  const tools = hostsTools(f, { versions: { pi: '1.4.0' } });
  tools.env.HOSTS_NPM_FAIL = '1';
  const home = f.env.KITTO_HOME, statePath = join(home, 'state.json');
  const before = snapshot(home), stateBefore = readFileSync(statePath, 'utf8');

  const failed = tools.run('hosts', '--apply');
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /exit 9/);
  assert.deepEqual(snapshot(home), before);
  assert.equal(readFileSync(statePath, 'utf8'), stateBefore);
  assert.equal(tools.versions().pi, '1.4.0');

  const broken = hostsTools(f, { versions: { pi: 'garbage' }, id: 'hosts-tools-broken' });
  const brokenBefore = snapshot(home);
  const unreadable = broken.run('hosts', '--apply');
  assert.notEqual(unreadable.status, 0);
  assert.match(unreadable.stderr, /Cannot read the current version/);
  assert.equal(broken.installs().length, 0);
  assert.deepEqual(snapshot(home), brokenBefore);
});

test('kitto hosts leaves unselected hosts alone and update still never upgrades hosts', t => {
  const f = fixture(t);
  good(f.cli('setup', '--agents', 'codex', '--source', f.source));
  withRemote(f);
  const tools = hostsTools(f, { versions: { pi: '1.0.0', codex: '0.169.0', dsh: '0.1.0' } });
  const home = f.env.KITTO_HOME, before = snapshot(home);

  const update = f.cli('update', '--check');
  good(update);
  assert.match(update.stdout, /Host CLIs \(Kitto never upgrades them/);
  assert.match(update.stdout, /codex: 0\.170\.0 \(Kitto tested baseline 0\.170\.0\)/);
  assert.deepEqual(snapshot(home), before);

  const applied = tools.run('hosts', '--apply');
  good(applied);
  assert.deepEqual(tools.installs().map(call => call.args[2]), ['@openai/codex@0.170.0']);
  assert(!tools.calls().some(call => call.command === 'pi' || call.command === 'dsh'));
});

test('kitto hosts leaves the app-managed DSH Desktop CLI to the Desktop app', t => {
  const f = fixture(t);
  mkdirSync(join(f.source, 'config/dsh'), { recursive: true });
  writeFileSync(join(f.source, 'config/dsh/AGENTS.md'), 'Desktop portable rules');
  commitAll(f, 'desktop rules');
  good(f.cli('setup', '--agents', 'dsh', '--dsh-profile', 'desktop', '--source', f.source));
  const tools = hostsTools(f, { missing: ['dsh'] });
  const home = f.env.KITTO_HOME, before = snapshot(home);

  const check = tools.run('hosts');
  good(check);
  assert.match(check.stdout, /dsh: app-managed by DeepSeek Harness Desktop; Kitto baseline 0\.2\.2-rc\.1/);
  assert.match(check.stdout, /Nothing for Kitto to manage/);

  const applied = tools.run('hosts', '--apply');
  good(applied);
  assert.match(applied.stdout, /app-managed by DeepSeek Harness Desktop; skipped/);
  assert.equal(tools.calls().some(call => call.command === 'npm'), false);
  assert.deepEqual(snapshot(home), before);

  const pinned = tools.run('hosts', '--host', 'dsh', '--version', '0.2.2-rc.1', '--apply');
  assert.notEqual(pinned.status, 0);
  assert.match(pinned.stderr, /app-managed/);
});

test('host version comparison keeps hyphenated prereleases intact', () => {
  // The old split('-', 2) truncated both to "alpha" and reported equality.
  assert.equal(compareVersions('1.0.0-alpha-2', '1.0.0-alpha-10'), 1);
  assert.equal(compareVersions('1.0.0-alpha-10', '1.0.0-alpha-2'), -1);
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0-rc.2'), -1);
  assert.equal(compareVersions('0.2.2-rc.3', '0.2.2-rc.1'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.9'), 1);
});

test('kitto hosts treats a mixed-case Desktop profile as app-managed', t => {
  const f = fixture(t);
  mkdirSync(join(f.source, 'config/dsh'), { recursive: true });
  writeFileSync(join(f.source, 'config/dsh/AGENTS.md'), 'Desktop portable rules');
  commitAll(f, 'desktop rules');
  good(f.cli('setup', '--agents', 'dsh', '--dsh-profile', 'desktop', '--source', f.source));
  const statePath = join(f.env.KITTO_HOME, 'state.json');
  const state = readJson(statePath);
  writeFileSync(statePath, JSON.stringify({ ...state, dshProfile: 'Desktop' }, null, 2) + '\n');
  const tools = hostsTools(f, { versions: { dsh: '0.2.2-rc.0' } });
  const home = f.env.KITTO_HOME, before = snapshot(home);

  const check = tools.run('hosts');
  good(check);
  assert.match(check.stdout, /dsh: app-managed by DeepSeek Harness Desktop/);
  const applied = tools.run('hosts', '--apply');
  good(applied);
  assert.match(applied.stdout, /app-managed by DeepSeek Harness Desktop; skipped/);
  assert.equal(tools.calls().some(call => call.command === 'npm'), false);
  assert.deepEqual(snapshot(home), before);
});

test('kitto hosts --apply fails clearly when npm is unavailable', t => {
  const f = fixture(t);
  good(f.cli('setup', '--agents', 'pi', '--source', f.source));
  const tools = hostsTools(f, { versions: { pi: '1.4.0' }, missing: ['npm'] });
  const statePath = join(f.env.KITTO_HOME, 'state.json'), stateBefore = readFileSync(statePath, 'utf8');

  const failed = tools.run('hosts', '--apply');
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /npm was not found on PATH/);
  assert.equal(tools.installs().length, 0);
  assert.equal(readFileSync(statePath, 'utf8'), stateBefore);
});

test('kitto hosts --apply fails when the installed CLI still reports the old version', t => {
  const f = fixture(t);
  good(f.cli('setup', '--agents', 'pi', '--source', f.source));
  const tools = hostsTools(f, { versions: { pi: '1.4.0' } });
  tools.env.HOSTS_NPM_NOOP = '1';
  const home = f.env.KITTO_HOME, before = snapshot(home);
  const statePath = join(home, 'state.json'), stateBefore = readFileSync(statePath, 'utf8');

  const failed = tools.run('hosts', '--apply');
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /reports 1\.4\.0 instead of 1\.5\.2/);
  assert.match(failed.stderr, /Kitto wrote no state/);
  assert.deepEqual(snapshot(home), before);
  assert.equal(readFileSync(statePath, 'utf8'), stateBefore);
});

test('a multi-host failure reports which hosts changed and which did not', t => {
  const f = fixture(t);
  good(f.cli('setup', '--agents', 'pi,codex', '--source', f.source));
  const tools = hostsTools(f, { versions: { pi: '1.4.0', codex: '0.169.0' } });
  tools.env.HOSTS_NPM_FAIL_PACKAGE = '@openai/codex';
  const home = f.env.KITTO_HOME, statePath = join(home, 'state.json');
  const stateBefore = readFileSync(statePath, 'utf8');

  const failed = tools.run('hosts', '--apply');
  assert.notEqual(failed.status, 0);
  assert.match(failed.stdout, /verified pi 1\.5\.2/);
  assert.match(failed.stdout, /Summary: updated pi; not updated codex/);
  assert.match(failed.stderr, /simulated npm failure for @openai\/codex/);
  assert.deepEqual(tools.installs().map(call => call.args[2]),
    ['@earendil-works/pi-coding-agent@1.5.2', '@openai/codex@0.170.0']);
  assert.equal(tools.versions().installed['@earendil-works/pi-coding-agent'], '1.5.2');
  assert.equal(tools.versions().installed['@openai/codex'], undefined);
  assert.equal(readFileSync(statePath, 'utf8'), stateBefore);
});

test('a permission failure explains the npm global prefix', t => {
  const f = fixture(t);
  good(f.cli('setup', '--agents', 'pi', '--source', f.source));
  const tools = hostsTools(f, { versions: { pi: '1.4.0' } });
  tools.env.HOSTS_NPM_PERMISSION = '1';
  const statePath = join(f.env.KITTO_HOME, 'state.json'), stateBefore = readFileSync(statePath, 'utf8');

  const failed = tools.run('hosts', '--apply');
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /EACCES|permission/i);
  assert.match(failed.stderr, /npm config set prefix|administrator/);
  assert.match(failed.stdout, /Summary: updated none; not updated pi/);
  assert.equal(readFileSync(statePath, 'utf8'), stateBefore);
});

test('kitto hosts leaves a newer host alone and does not suggest an apply', t => {
  const f = fixture(t);
  good(f.cli('setup', '--agents', 'pi', '--source', f.source));
  const tools = hostsTools(f, { versions: { pi: '9.9.9' } });

  const check = tools.run('hosts');
  good(check);
  assert.match(check.stdout, /newer than the baseline; Kitto does not downgrade/);
  assert.match(check.stdout, /Nothing for Kitto to change/);
  assert.doesNotMatch(check.stdout, /run `kitto hosts --apply`/);

  const applied = tools.run('hosts', '--apply');
  good(applied);
  assert.match(applied.stdout, /Summary: updated none; unchanged pi/);
  assert.match(applied.stdout, /Nothing to change/);
  assert.equal(tools.installs().length, 0);
  assert.equal(tools.calls().some(call => call.command === 'npm'), false);
});

test('kitto hosts warns in check mode when --version is not the validated baseline', t => {
  const f = fixture(t);
  good(f.cli('setup', '--agents', 'pi,codex', '--source', f.source));
  const tools = hostsTools(f, { versions: { pi: '1.5.2', codex: '0.170.0' } });

  const check = tools.run('hosts', '--host', 'codex', '--version', '0.169.5');
  good(check);
  assert.match(check.stdout, /WARNING: 0\.169\.5 is an explicit --version pin, not the Kitto-validated baseline 0\.170\.0/);
  assert.match(check.stdout, /Preview only/);
  assert.equal(tools.installs().length, 0);
});

test('kitto hosts warns in apply mode even when the pinned version needs no change', t => {
  const f = fixture(t);
  good(f.cli('setup', '--agents', 'pi', '--source', f.source));
  const tools = hostsTools(f, { versions: { pi: '9.9.9' } });

  const applied = tools.run('hosts', '--version', '9.9.9', '--apply');
  good(applied);
  assert.match(applied.stdout, /WARNING: 9\.9\.9 is an explicit --version pin, not the Kitto-validated baseline 1\.5\.2/);
  assert.match(applied.stdout, /Summary: updated none; unchanged pi/);
  assert.equal(tools.installs().length, 0);
  assert.equal(tools.calls().some(call => call.command === 'npm'), false);
});

test('the maintenance runner exposes the same explicit host policy', t => {
  const f = fixture(t);
  good(f.cli('setup', '--agents', 'codex', '--source', f.source));
  const tools = hostsTools(f, { versions: { codex: '0.169.0' } });
  const result = command(process.execPath,
    [join(f.env.KITTO_HOME, 'runtime/bin/maintain.mjs'), 'hosts'], tools.env);
  good(result);
  assert.match(result.stdout, /codex: current 0\.169\.0; Kitto baseline 0\.170\.0/);
  assert.match(result.stdout, /check only; no writes/);
});
