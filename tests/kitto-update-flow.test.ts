import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { dist, command, fixture, good, readJson } from './helpers/kitto-fixture.ts';
import { requireEnv } from './helpers/kitto-suite.ts';

test('maintenance runner finds custom home without inheriting setup environment', (t) => {
  const f = fixture(t);
  good(f.cli('setup', '--agents', 'codex', '--source', f.source));
  const runtime = requireEnv(f.env, 'KITTO_HOME');
  delete f.env.KITTO_HOME;
  good(command(process.execPath, [join(runtime, 'runtime/bin/maintain.mjs'), 'status'], f.env));
});

test('lock rejects concurrent mutation and dirty source rejects update', (t) => {
  const f = fixture(t);
  good(f.cli('setup', '--agents', 'codex', '--source', f.source));
  mkdirSync(join(requireEnv(f.env, 'KITTO_HOME'), '.lock'));
  assert.match(f.maintain('sync', '--apply').stderr, /exists without an owner record/);
  rmSync(join(requireEnv(f.env, 'KITTO_HOME'), '.lock'), { recursive: true });
  writeFileSync(join(f.source, 'uncommitted.txt'), 'work');
  assert.match(f.maintain('update', '--apply').stderr, /local changes/);
  assert.equal(readFileSync(join(f.source, 'uncommitted.txt'), 'utf8'), 'work');
});

test('--version and -v print the packaged version without reading state', (t) => {
  const f = fixture(t);
  const home = requireEnv(f.env, 'KITTO_HOME');
  const version = readJson(join(dist, 'package.json')).version;
  for (const flag of ['--version', '-v']) {
    const result = f.cli(flag);
    good(result);
    assert.equal(result.stdout.trim(), version, flag);
    assert.equal(existsSync(join(home, 'state.json')), false, `${flag} must not create state`);
  }
});

test('remote bootstrap clones internally and later updates only by fast-forward', (t) => {
  const f = fixture(t),
    mirror = join(f.temp, 'remote.git');
  good(command('git', ['clone', '--bare', f.source, mirror], f.env));
  const config = join(f.temp, 'gitconfig');
  writeFileSync(config, '');
  f.env.GIT_CONFIG_GLOBAL = config;
  good(command('git', ['config', '--file', config, `url.${mirror}.insteadOf`, 'https://kitto.invalid/config.git'], f.env));
  good(f.cli('setup', '--agents', 'codex', '--source', 'https://kitto.invalid/config.git', '--ref', 'main'));
  const managed = join(requireEnv(f.env, 'KITTO_HOME'), 'config');
  assert.equal(readJson(join(requireEnv(f.env, 'KITTO_HOME'), 'state.json')).source, managed);
  good(command('git', ['remote', 'add', 'origin', mirror], f.env, f.source));
  writeFileSync(join(f.source, 'skills/example/SKILL.md'), 'new remote skill');
  for (const args of [
    ['add', '.'],
    ['commit', '-m', 'update'],
    ['push', 'origin', 'main'],
  ])
    good(command('git', args, f.env, f.source));
  const before = command('git', ['rev-parse', 'HEAD'], f.env, managed).stdout;
  good(f.maintain('update'));
  assert.equal(command('git', ['rev-parse', 'HEAD'], f.env, managed).stdout, before);
  good(f.maintain('update', '--apply'));
  assert.notEqual(command('git', ['rev-parse', 'HEAD'], f.env, managed).stdout, before);
  assert.equal(readFileSync(join(requireEnv(f.env, 'PI_AGENTS_DIR'), 'skills/example/SKILL.md'), 'utf8'), 'new remote skill');
});
