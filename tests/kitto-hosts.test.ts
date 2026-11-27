import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { compareVersions } from '../lib/hosts.ts';
import { hosts, meetsBaseline } from '../lib/kitto.ts';
import { re, root, dist, command, fixture, good, readJson, callsOf, snapshot, withRemote, commitAll } from './helpers/kitto-fixture.ts';

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
    run: (...args) => command(process.execPath, [join(dist, 'bin/kitto.mjs'), ...args], env),
  };
}

test('kitto hosts check reports selected versions and baselines without writes', t => {
  const f = fixture(t);
  good(f.cli('setup', '--agents', 'pi,codex', '--source', f.source));
  const tools = hostsTools(f, { versions: { pi: '1.4.0', codex: hosts.codex.version } });
  const home = f.env.KITTO_HOME, statePath = join(home, 'state.json');
  const before = snapshot(home), stateBefore = readFileSync(statePath, 'utf8');

  const result = tools.run('hosts');
  good(result);
  assert.match(result.stdout, /host CLIs \(check only; no writes\)/);
  assert.match(result.stdout, new RegExp(String.raw`pi: current 1\.4\.0; Kitto baseline ${re(hosts.pi.version)}; target ${re(hosts.pi.version)}; upgrade needed`));
  assert.match(result.stdout, new RegExp(String.raw`native manager: npm install --global @earendil-works\/pi-coding-agent@${re(hosts.pi.version)}`));
  assert.match(result.stdout, new RegExp(String.raw`codex: current ${re(hosts.codex.version)}; Kitto baseline ${re(hosts.codex.version)}`));
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
  const notSetup = command(process.execPath, [join(dist, 'bin/kitto.mjs'), 'hosts'], missingState);
  assert.notEqual(notSetup.status, 0);
  assert.match(notSetup.stderr, /not set up/);
});

test('kitto hosts --apply installs the exact baseline for outdated selected hosts only', t => {
  const f = fixture(t);
  good(f.cli('setup', '--agents', 'pi,codex', '--source', f.source));
  const tools = hostsTools(f, { versions: { pi: '1.4.0', codex: hosts.codex.version } });
  const home = f.env.KITTO_HOME, statePath = join(home, 'state.json');
  const stateBefore = readFileSync(statePath, 'utf8');

  const result = tools.run('hosts', '--apply');
  good(result);
  assert.match(result.stdout, new RegExp(String.raw`pi: current 1\.4\.0 -> ${re(hosts.pi.version)}`));
  assert.match(result.stdout, new RegExp(String.raw`verified pi ${re(hosts.pi.version)}`));
  assert.deepEqual(tools.installs(),
    [{ command: 'npm', args: ['install', '--global', `@earendil-works/pi-coding-agent@${hosts.pi.version}`] }]);
  assert.equal(tools.versions().installed['@earendil-works/pi-coding-agent'], hosts.pi.version);
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
    [{ command: 'npm', args: ['install', '--global', `@deepseek-ai/dsh@${hosts.dsh.version}`] }]);
  assert.match(result.stdout, new RegExp(String.raw`verified dsh ${re(hosts.dsh.version)}`));
});

test('kitto hosts --version pins one exact version and refuses dist-tags', t => {
  const f = fixture(t);
  good(f.cli('setup', '--agents', 'pi,codex', '--source', f.source));
  const tools = hostsTools(f, { versions: { pi: hosts.pi.version, codex: hosts.codex.version } });

  const pinned = tools.run('hosts', '--host', 'codex', '--version', '0.169.5', '--apply');
  good(pinned);
  assert.match(pinned.stdout, new RegExp(String.raw`Explicit pin overrides the Kitto-validated baseline for codex \(${re(hosts.codex.version)} -> 0\.169\.5\)`));
  assert.match(pinned.stdout, /verified codex 0\.169\.5/);
  assert.deepEqual(tools.installs(),
    [{ command: 'npm', args: ['install', '--global', '@openai/codex@0.169.5'] }]);

  const ambiguous = tools.run('hosts', '--version', hosts.pi.version);
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
  assert.match(update.stdout, new RegExp(String.raw`codex: ${re(hosts.codex.version)} \(Kitto tested baseline ${re(hosts.codex.version)}\)`));
  assert.deepEqual(snapshot(home), before);

  const applied = tools.run('hosts', '--apply');
  good(applied);
  assert.deepEqual(tools.installs().map(call => call.args[2]), [`@openai/codex@${hosts.codex.version}`]);
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
  assert.match(check.stdout, new RegExp(String.raw`dsh: app-managed by DeepSeek Harness Desktop; Kitto baseline ${re(hosts.dsh.version)}`));
  assert.match(check.stdout, /Nothing for Kitto to manage/);

  const applied = tools.run('hosts', '--apply');
  good(applied);
  assert.match(applied.stdout, /app-managed by DeepSeek Harness Desktop; skipped/);
  assert.equal(tools.calls().some(call => call.command === 'npm'), false);
  assert.deepEqual(snapshot(home), before);

  const pinned = tools.run('hosts', '--host', 'dsh', '--version', hosts.dsh.version, '--apply');
  assert.notEqual(pinned.status, 0);
  assert.match(pinned.stderr, /app-managed/);
});

test('host version comparison keeps hyphenated prereleases intact', () => {
  assert.equal(compareVersions('1.0.0-alpha-2', '1.0.0-alpha-10'), 1);
  assert.equal(compareVersions('1.0.0-alpha-10', '1.0.0-alpha-2'), -1);
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0-rc.2'), -1);
  assert.equal(compareVersions('0.2.2-rc.3', '0.2.2-rc.1'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.9'), 1);
  assert.equal(compareVersions('1.0.0-9007199254740992', '1.0.0-9007199254740993'), -1);
  assert.equal(compareVersions('9007199254740992.0.0', '9007199254740993.0.0'), -1);
  assert.equal(compareVersions('1.0.0+first', '1.0.0+second'), 0);
  assert.equal(meetsBaseline(' v1.0.0+build ', '1.0.0'), true);
  for (const malformed of ['1.0', '01.0.0', '1.0.0-alpha..2', '1.0.0-01', '1.0.0+build.', '1.0.0_foo']) {
    assert.equal(compareVersions(malformed, '1.0.0'), null, malformed);
    assert.equal(meetsBaseline(malformed, '1.0.0'), false, malformed);
  }
});

test('kitto hosts refuses malformed version output and malformed exact pins', t => {
  const f = fixture(t);
  good(f.cli('setup', '--agents', 'pi', '--source', f.source));
  const tools = hostsTools(f, { versions: { pi: '1.5.2-alpha..2' } });
  const invalid = tools.run('hosts', '--version', '1.5.2-alpha..2');
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /exact semantic version/);
  const unreadable = tools.run('hosts', '--apply');
  assert.notEqual(unreadable.status, 0);
  assert.match(unreadable.stderr, /Cannot read the current version/);
  assert.equal(tools.installs().length, 0);
});

test('setup accepts a newer host but rejects it as the result of a pinned install', t => {
  const f = fixture(t);
  const tools = hostsTools(f, { missing: ['pi', 'npm'] });
  const marker = join(tools.bin, 'installed');
  writeFileSync(join(tools.bin, 'pi'), `#!${process.execPath}\nif (!require('node:fs').existsSync(${JSON.stringify(marker)})) process.exit(1);\nconsole.log('pi 1.5.3');\n`, { mode: 0o755 });
  writeFileSync(join(tools.bin, 'npm'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(' '));\n`, { mode: 0o755 });
  const module = new URL('../lib/kitto.ts', import.meta.url).href;
  const invoke = body => command(process.execPath, ['--input-type=module', '-e', `import { checkSelectedHosts, installMissingHosts } from ${JSON.stringify(module)}; ${body}`], tools.env);
  const installed = invoke("installMissingHosts(['pi'])");
  assert.notEqual(installed.status, 0);
  assert.match(installed.stderr, new RegExp(String.raw`reports 1\.5\.3 instead of ${re(hosts.pi.version)}`));
  assert.equal(readFileSync(marker, 'utf8'), `install --global @earendil-works/pi-coding-agent@${hosts.pi.version}`);
  good(invoke("checkSelectedHosts(['pi'], false)"));
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
  assert.match(failed.stderr, new RegExp(String.raw`reports 1\.4\.0 instead of ${re(hosts.pi.version)}`));
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
  assert.match(failed.stdout, new RegExp(String.raw`verified pi ${re(hosts.pi.version)}`));
  assert.match(failed.stdout, /Summary: updated pi; not updated codex/);
  assert.match(failed.stderr, /simulated npm failure for @openai\/codex/);
  assert.deepEqual(tools.installs().map(call => call.args[2]),
    [`@earendil-works/pi-coding-agent@${hosts.pi.version}`, `@openai/codex@${hosts.codex.version}`]);
  assert.equal(tools.versions().installed['@earendil-works/pi-coding-agent'], hosts.pi.version);
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

test('public and maintenance hosts distinguish equivalent precedence from an exact build pin', t => {
  const f = fixture(t);
  good(f.cli('setup', '--agents', 'pi', '--source', f.source));
  const tools = hostsTools(f, { versions: { pi: '1.5.2+local' } });
  const maintain = (...args) => command(process.execPath,
    [join(f.env.KITTO_HOME, 'runtime/bin/maintain.mjs'), ...args], tools.env);
  for (const run of [tools.run, maintain]) {
    const check = run('hosts', '--check');
    good(check);
    assert.match(check.stdout, /same precedence as the baseline, but different build metadata/);
    assert.doesNotMatch(check.stdout, /newer than the baseline|Preview only/);
    const apply = run('hosts', '--apply');
    good(apply);
    assert.match(apply.stdout, /same precedence as the baseline, but different build metadata/);
    assert.match(apply.stdout, /Summary: updated none; unchanged pi/);
  }
  assert.equal(tools.calls().some(call => call.command === 'npm'), false);

  tools.env.HOSTS_NPM_NOOP = '1';
  const mismatch = maintain('hosts', '--version', hosts.pi.version, '--apply');
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, new RegExp(String.raw`reports 1\.5\.2\+local instead of ${re(hosts.pi.version)}`));
  delete tools.env.HOSTS_NPM_NOOP;
  const pinned = tools.run('hosts', '--version', hosts.pi.version, '--apply');
  good(pinned);
  assert.match(pinned.stdout, new RegExp(String.raw`verified pi ${re(hosts.pi.version)}\b`));
  assert.equal(tools.installs().length, 2);
});

test('kitto hosts warns in check mode when --version is not the validated baseline', t => {
  const f = fixture(t);
  good(f.cli('setup', '--agents', 'pi,codex', '--source', f.source));
  const tools = hostsTools(f, { versions: { pi: hosts.pi.version, codex: hosts.codex.version } });

  const check = tools.run('hosts', '--host', 'codex', '--version', '0.169.5');
  good(check);
  assert.match(check.stdout, new RegExp(String.raw`WARNING: 0\.169\.5 is an explicit --version pin, not the Kitto-validated baseline ${re(hosts.codex.version)}`));
  assert.match(check.stdout, /Preview only/);
  assert.equal(tools.installs().length, 0);
});

test('kitto hosts warns in apply mode even when the pinned version needs no change', t => {
  const f = fixture(t);
  good(f.cli('setup', '--agents', 'pi', '--source', f.source));
  const tools = hostsTools(f, { versions: { pi: '9.9.9' } });

  const applied = tools.run('hosts', '--version', '9.9.9', '--apply');
  good(applied);
  assert.match(applied.stdout, new RegExp(String.raw`WARNING: 9\.9\.9 is an explicit --version pin, not the Kitto-validated baseline ${re(hosts.pi.version)}`));
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
  assert.match(result.stdout, new RegExp(String.raw`codex: current 0\.169\.0; Kitto baseline ${re(hosts.codex.version)}`));
  assert.match(result.stdout, /check only; no writes/);
});

test('a host below the tested baseline warns and keeps deploying the other hosts', t => {
  const f = fixture(t);
  f.env.FAKE_HOST_VERSIONS = JSON.stringify({ codex: '0.167.1' });
  const result = f.cli('setup', '--agents', 'pi,codex', '--source', f.source);
  good(result);
  assert.match(result.stderr, new RegExp(String.raw`kitto: codex: 0\.167\.1 is older than the tested baseline ${re(hosts.codex.version)}`));
  assert.match(result.stderr, /continuing and skipping the steps this CLI cannot support/);
  assert.match(readFileSync(join(f.env.PI_CODING_AGENT_DIR, 'AGENTS.md'), 'utf8'), /Pi instructions/);
  const state = readJson(join(f.env.KITTO_HOME, 'state.json'));
  assert.equal(state.ready, true);
  assert.deepEqual(state.agents, ['pi', 'codex']);
  assert(callsOf(f).some(c => c.command === 'codex' && c.args[0] === 'plugin' && c.args.includes('add')));
});

test('a host without the plugin subcommand skips only its native integration', t => {
  const f = fixture(t);
  f.env.FAKE_HOST_NO_HELP = 'codex';
  const result = f.cli('setup', '--agents', 'pi,codex', '--source', f.source);
  good(result);
  assert.match(result.stderr, /this codex CLI has no plugin subcommand/);
  assert.match(readFileSync(join(f.env.PI_CODING_AGENT_DIR, 'AGENTS.md'), 'utf8'), /Pi instructions/);
  assert(!callsOf(f).some(c => c.command === 'codex' && c.args[0] === 'plugin' && !c.args.includes('--help')));
  assert.equal(readJson(join(f.env.KITTO_HOME, 'state.json')).ready, true);
});

test('--require-baseline makes an untested host version fatal again', t => {
  const f = fixture(t);
  f.env.FAKE_HOST_VERSIONS = JSON.stringify({ codex: '0.167.1' });
  const failed = f.cli('setup', '--agents', 'pi,codex', '--source', f.source, '--require-baseline');
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, new RegExp(String.raw`codex: 0\.167\.1 is older than the tested baseline ${re(hosts.codex.version)}`));
  assert.equal(existsSync(join(f.env.KITTO_HOME, 'state.json')), false);
  assert.equal(existsSync(join(f.env.PI_CODING_AGENT_DIR, 'AGENTS.md')), false);
});
