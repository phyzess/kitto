import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { treeHash } from '../lib/kitto.ts';
import { list } from '../lib/ownership.ts';
import { root, publishRoot, command, fixture, good, readJson, snapshot, release, withRemote, commitAll } from './helpers/kitto-fixture.ts';
import { requireEnv } from './helpers/kitto-suite.ts';

test('kitto update refreshes the runtime copy, deploys the new source and records a checkpoint', async (t) => {
  const f = fixture(t),
    a = release(f, '0.1.0-test.1'),
    b = release(f, '0.1.0-test.2', 'update');
  good(a('--agents', 'codex', '--source', f.source));
  const home = requireEnv(f.env, 'KITTO_HOME'),
    runtime = join(home, 'runtime'),
    statePath = join(home, 'state.json');
  const skill = join(requireEnv(f.env, 'PI_AGENTS_DIR'), 'skills/example/SKILL.md');
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
  assert.equal(state.runtimeHash, await treeHash(runtime));
  assert.equal(state.pendingRuntime, undefined);
  assert.notEqual(deployed.commit, state.deployed.commit);
  const checkpoint = readJson(join(home, 'runtime.previous.json'));
  assert.equal(checkpoint.version, '0.1.0-test.1');
  assert.equal(checkpoint.hash, await treeHash(join(home, 'runtime.previous')));
  assert(existsSync(join(home, 'runtime.previous/lib/kitto.mjs')));
  const installed = snapshot(home);
  const refreshed = command(process.execPath, [join(runtime, 'bin/kitto.mjs'), 'update', '--check'], f.env);
  good(refreshed);
  assert.match(refreshed.stdout, /Runtime: 0\.1\.0-test\.2 \(this entry runs from the installed copy/);
  assert.doesNotMatch(refreshed.stdout, /Runtime: 0\.1\.0-test\.2 ->/);
  assert.deepEqual(snapshot(home), installed);
  good(f.maintain('status'));
});

test('a failed deployment after the runtime swap is not verified and stays recoverable', (t) => {
  const f = fixture(t),
    a = release(f, '0.1.0-test.1'),
    b = release(f, '0.1.0-test.2', 'update');
  good(a('--agents', 'codex', '--source', f.source));
  const home = requireEnv(f.env, 'KITTO_HOME'),
    statePath = join(home, 'state.json'),
    runtime = join(home, 'runtime');
  const verifiedHash = readJson(statePath).runtimeHash;
  withRemote(f);
  writeFileSync(join(f.source, 'config/pi/mcp.json'), JSON.stringify({ mcpServers: { debug: { command: 'debug-mcp' } } }));
  commitAll(f, 'add mcp server');
  good(command('git', ['push', 'origin', 'main'], f.env, f.source));
  f.env.FAKE_MCP_FAIL_ADD = 'debug';
  const failed = b('--apply');
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /simulated MCP add failure/);
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

test('a failed update is never checkpointed and a later update keeps the real checkpoint', (t) => {
  const f = fixture(t),
    a = release(f, '0.1.0-test.1'),
    b = release(f, '0.1.0-test.2', 'update'),
    c = release(f, '0.1.0-test.3', 'update');
  good(a('--agents', 'codex', '--source', f.source));
  const home = requireEnv(f.env, 'KITTO_HOME'),
    statePath = join(home, 'state.json');
  withRemote(f);
  writeFileSync(join(f.source, 'config/pi/mcp.json'), JSON.stringify({ mcpServers: { debug: { command: 'debug-mcp' } } }));
  commitAll(f, 'add mcp server');
  good(command('git', ['push', 'origin', 'main'], f.env, f.source));
  f.env.FAKE_MCP_FAIL_ADD = 'debug';
  assert.notEqual(b('--apply').status, 0);
  assert.equal(readJson(join(home, 'runtime.previous.json')).version, '0.1.0-test.1');
  delete f.env.FAKE_MCP_FAIL_ADD;
  good(c('--apply'));
  const state = readJson(statePath);
  assert.equal(state.version, '0.1.0-test.3');
  assert.equal(state.pendingRuntime, undefined);
  assert.equal(readJson(join(home, 'runtime.previous.json')).version, '0.1.0-test.1');
  good(f.cli('setup', '--recover'));
  assert.equal(readJson(join(home, 'runtime/package.json')).version, '0.1.0-test.1');
  assert.equal(readJson(statePath).version, '0.1.0-test.1');
});

test('an installRuntime failure leaves the verified runtime and state intact', (t) => {
  const f = fixture(t),
    a = release(f, '0.1.0-test.1'),
    b = release(f, '0.1.0-test.2', 'update');
  good(a('--agents', 'codex', '--source', f.source));
  const home = requireEnv(f.env, 'KITTO_HOME'),
    runtime = join(home, 'runtime'),
    statePath = join(home, 'state.json');
  withRemote(f);
  const stateBefore = readFileSync(statePath, 'utf8');
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

test('maintain update fast-forwards and redeploys without replacing its own runtime', (t) => {
  const f = fixture(t),
    a = release(f, '0.1.0-test.1');
  good(a('--agents', 'codex', '--source', f.source));
  const home = requireEnv(f.env, 'KITTO_HOME'),
    runtime = join(home, 'runtime');
  withRemote(f);
  writeFileSync(join(f.source, 'skills/example/SKILL.md'), 'maintain update content');
  commitAll(f, 'maintain config');
  good(command('git', ['push', 'origin', 'main'], f.env, f.source));
  const before = snapshot(home);
  const preview = f.maintain('update');
  good(preview);
  assert.match(preview.stdout, /Runtime: 0\.1\.0-test\.1 \(this entry runs from the installed copy/);
  assert.doesNotMatch(preview.stdout, /Runtime: 0\.1\.0-test\.1 ->/);
  assert.deepEqual(snapshot(home), before);
  assert.equal(readJson(join(runtime, 'package.json')).version, '0.1.0-test.1');
  good(f.maintain('update', '--apply'));
  assert.match(readJson(join(home, 'state.json')).deployed.commit, /./);
  assert.equal(readFileSync(join(requireEnv(f.env, 'PI_AGENTS_DIR'), 'skills/example/SKILL.md'), 'utf8'), 'maintain update content');
  assert.equal(readJson(join(runtime, 'package.json')).version, '0.1.0-test.1');
  assert.equal(readJson(join(home, 'state.json')).version, '0.1.0-test.1');
});

test('the installed runtime is recognized through a symlinked KITTO_HOME', (t) => {
  const f = fixture(t);
  const alias = join(f.temp, 'home-alias');
  symlinkSync(f.home, alias, 'dir');
  f.env.KITTO_HOME = join(alias, 'kitto');
  good(f.cli('setup', '--agents', 'codex', '--source', f.source));
  withRemote(f);
  const version = readJson(join(root, 'package.json')).version;
  const home = join(f.home, 'kitto'),
    runtime = join(alias, 'kitto', 'runtime');
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

test('packed installation survives removal of the npm execution directory', (t) => {
  const f = fixture(t);
  const packed = command('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', f.temp], f.env, publishRoot);
  good(packed);
  const archive = join(f.temp, JSON.parse(packed.stdout)[0].filename),
    extracted = join(f.temp, 'extracted');
  mkdirSync(extracted);
  good(command('tar', ['-xzf', archive, '-C', extracted], f.env));
  good(command(process.execPath, [join(extracted, 'package/bin/kitto.mjs'), 'setup', '--agents', 'codex', '--source', f.source], f.env));
  rmSync(extracted, { recursive: true });
  good(f.maintain('status'));
  good(f.maintain('versions'));
});

test('packed npm artifact excludes personal configuration and all undeclared assets', (t) => {
  const f = fixture(t);
  const result = command('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], f.env, publishRoot);
  good(result);
  const paths = JSON.parse(result.stdout)[0].files.map((file: { path: string }) => file.path);
  assert(paths.includes('integration/skills/kitto/SKILL.md'));
  assert(paths.includes('bin/kitto.mjs'));
  for (const path of paths)
    assert.match(
      path,
      /^(bin\/[^/]+\.mjs|lib\/(hosts\/)?[^/]+\.(mjs|py)|integration\/|sync\.sh$|package\.json$|README\.md$|CHANGELOG\.md$)/,
    );
  assert(!paths.some((path: string) => /^(config|skills|lists|tests)\//.test(path)));
  assert(!paths.some((path: string) => path.endsWith('.map')));
});

test('failed upgrade retries preserve the working checkpoint, and external setup recovers broken code', (t) => {
  const f = fixture(t),
    a = release(f, '0.1.0-test.1'),
    b = release(f, '0.1.0-test.2');
  good(a('--agents', 'codex', '--source', f.source));
  f.env.FAIL_HOST = 'codex';
  assert.notEqual(b().status, 0);
  const checkpoint = join(requireEnv(f.env, 'KITTO_HOME'), 'runtime.previous.json'),
    before = readFileSync(checkpoint, 'utf8');
  assert.equal(readJson(checkpoint).version, '0.1.0-test.1');
  assert.notEqual(b().status, 0);
  assert.equal(readFileSync(checkpoint, 'utf8'), before);
  const statePath = join(requireEnv(f.env, 'KITTO_HOME'), 'state.json'),
    state = readFileSync(statePath, 'utf8');
  good(f.maintain('recover'));
  assert.equal(readFileSync(statePath, 'utf8'), state);
  rmSync(f.source, { recursive: true });
  writeFileSync(join(requireEnv(f.env, 'KITTO_HOME'), 'runtime/bin/maintain.mjs'), 'broken syntax !');
  good(f.cli('setup', '--recover', '--dry-run'));
  assert.notEqual(f.cli('setup', '--recover').status, 0);
  assert.equal(readJson(statePath).ready, false);
  assert.equal(readFileSync(checkpoint, 'utf8'), before);
  delete f.env.FAIL_HOST;
  good(f.cli('setup', '--recover'));
  assert.equal(readJson(statePath).version, '0.1.0-test.1');
  assert.equal(readJson(statePath).ready, true);
  assert.deepEqual(list(readJson(statePath), 'skill', 'shared', 'owned'), list(JSON.parse(state), 'skill', 'shared', 'owned'));
  assert.equal(readFileSync(join(requireEnv(f.env, 'PI_AGENTS_DIR'), 'skills/example/SKILL.md'), 'utf8').includes('Example body'), true);
  good(f.maintain('status'));
});

test('same-version setup does not erase a prior version checkpoint', (t) => {
  const f = fixture(t),
    a = release(f, '0.1.0-test.1'),
    b = release(f, '0.1.0-test.2');
  good(a('--agents', 'codex', '--source', f.source));
  good(b());
  good(b());
  assert.equal(readJson(join(requireEnv(f.env, 'KITTO_HOME'), 'runtime.previous.json')).version, '0.1.0-test.1');
  good(f.maintain('recover', '--apply'));
  assert.equal(readJson(join(requireEnv(f.env, 'KITTO_HOME'), 'state.json')).version, '0.1.0-test.1');
});

test('tampered checkpoint is rejected without changing the active installation', (t) => {
  const f = fixture(t),
    a = release(f, '0.1.0-test.1'),
    b = release(f, '0.1.0-test.2');
  good(a('--agents', 'codex', '--source', f.source));
  good(b());
  writeFileSync(join(requireEnv(f.env, 'KITTO_HOME'), 'runtime.previous/lib/kitto.mjs'), 'modified');
  assert.match(f.maintain('recover', '--apply').stderr, /checkpoint was modified/);
  assert.equal(readJson(join(requireEnv(f.env, 'KITTO_HOME'), 'state.json')).version, '0.1.0-test.2');
  assert.equal(existsSync(join(requireEnv(f.env, 'KITTO_HOME'), '.lock')), false);
});
