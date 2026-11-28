import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { list } from '../lib/ownership.ts';
import { downgradeState } from '../lib/state-schema.ts';
import { previewMatches, waitForPublish } from '../scripts/release.ts';
import { skillNames, command, fixture, good, readJson, withRemote, commitAll } from './helpers/kitto-fixture.ts';
import type { Fixture } from './helpers/kitto-fixture.ts';
import { requireEnv } from './helpers/kitto-suite.ts';

function installAsSchemaOne(f: Fixture, packages: string[] = []) {
  good(f.cli('setup', '--agents', 'pi', '--source', f.source));
  const statePath = join(requireEnv(f.env, 'KITTO_HOME'), 'state.json');
  assert.equal(readJson(statePath).schema, 2, 'new installs write schema 2');
  const original = JSON.stringify(downgradeState(readJson(statePath)), null, 2) + '\n';
  writeFileSync(statePath, original);
  rmSync(join(requireEnv(f.env, 'KITTO_HOME'), 'state.v1.json'), { force: true });
  const local = join(f.source, 'config/pi/local');
  mkdirSync(local, { recursive: true });
  writeFileSync(join(local, 'managed-packages.json'), JSON.stringify(packages));
  return {
    statePath,
    original,
    managed: join(local, 'managed-packages.json'),
    backup: join(requireEnv(f.env, 'KITTO_HOME'), 'state.v1.json'),
  };
}

const foreignLauncher = '#!/bin/sh\necho mine\n';

test('a stale lock reports its owner and --break-lock clears both locks', (t) => {
  const f = fixture(t);
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  const lock = join(requireEnv(f.env, 'KITTO_HOME'), '.lock');
  mkdirSync(lock, { recursive: true });
  writeFileSync(
    join(lock, 'owner.json'),
    JSON.stringify({ pid: dead, startedAt: '2026-01-01T00:00:00.000Z', command: 'setup --agents pi' }),
  );
  mkdirSync(join(f.source, 'config/pi/local/.sync-lock'), { recursive: true });
  writeFileSync(join(f.source, 'config/pi/local/.sync-lock/pid'), `${dead}\n`);

  const blocked = f.cli('setup', '--agents', 'pi', '--source', f.source);
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, new RegExp(`is a stale lock: pid ${dead}`));
  assert.match(blocked.stderr, /--break-lock/);

  const released = f.cli('setup', '--agents', 'pi', '--source', f.source, '--break-lock');
  good(released);
  assert.match(released.stdout, new RegExp(`removed stale lock .*\\(pid ${dead} is no longer running\\)`));
  assert.match(released.stdout, new RegExp(`removed stale sync lock .*\\(pid ${dead} is no longer running\\)`));
  assert.equal(existsSync(lock), false);
  assert.equal(existsSync(join(f.source, 'config/pi/local/.sync-lock')), false);
  assert.equal(readJson(join(requireEnv(f.env, 'KITTO_HOME'), 'state.json')).ready, true);
});

test('a live lock is never displaced, even with --break-lock', (t) => {
  const f = fixture(t);
  const lock = join(requireEnv(f.env, 'KITTO_HOME'), '.lock');
  mkdirSync(lock, { recursive: true });
  writeFileSync(
    join(lock, 'owner.json'),
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), command: 'setup --agents pi' }),
  );

  const blocked = f.cli('setup', '--agents', 'pi', '--source', f.source, '--break-lock');
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, new RegExp(`Another Kitto operation holds .*: pid ${process.pid}`));
  assert.match(blocked.stderr, /Wait for it to finish/);
  assert.equal(existsSync(join(lock, 'owner.json')), true);
});

test('a stored release preview is reused only for the same version, commit and tarball', () => {
  const record = { version: '0.5.0', commit: 'a'.repeat(40), integrity: 'sha512-abc', tarball: '/tmp/example.tgz' };
  assert.equal(previewMatches(record, record.commit, '0.5.0', 'sha512-abc'), true);
  assert.equal(previewMatches(record, 'b'.repeat(40), '0.5.0', 'sha512-abc'), false, 'another commit must verify again');
  assert.equal(previewMatches(record, record.commit, '0.5.1', 'sha512-abc'), false, 'another version must verify again');
  assert.equal(previewMatches(record, record.commit, '0.5.0', 'sha512-other'), false, 'a changed tarball must verify again');
  assert.equal(previewMatches(record, record.commit, '0.5.0', undefined), false, 'a missing tarball must verify again');
  assert.equal(previewMatches(undefined, record.commit, '0.5.0', 'sha512-abc'), false, 'no stored preview must verify');
});

test('release verification polls npm before reporting a result', () => {
  const reads = [undefined, undefined, undefined, 'sha512-abc'];
  let slept = 0;
  const attempt = waitForPublish('@phyzess/kitto@0.3.2', 'sha512-abc', () => reads.shift(), {
    attempts: 5,
    delayMs: 15_000,
    sleep: (ms) => {
      slept += ms;
    },
  });
  assert.equal(attempt, 4);
  assert.equal(slept, 45_000);
});

test('release verification rejects contents that differ from the tarball', () => {
  assert.throws(
    () => waitForPublish('@phyzess/kitto@0.3.2', 'sha512-abc', () => 'sha512-other', { attempts: 5, sleep: () => {} }),
    /is on npm with different contents/,
  );
});

test('release verification gives up with the expected integrity', () => {
  let calls = 0;
  assert.throws(
    () =>
      waitForPublish(
        '@phyzess/kitto@0.3.2',
        'sha512-abc',
        () => {
          calls += 1;
        },
        { attempts: 3, delayMs: 1, sleep: () => {} },
      ),
    /after 3 attempts.*sha512-abc/,
  );
  assert.equal(calls, 3);
});

test('a failed configuration fetch leaves the schema 1 state and writes no backup', (t) => {
  const f = fixture(t);
  const v1 = installAsSchemaOne(f);
  withRemote(f);
  commitAll(f, 'fixture');
  good(command('git', ['push', 'origin', 'main'], f.env, f.source));
  const shim = join(f.temp, 'bin', 'git');
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  assert.ok(realGit, 'git must be on PATH');
  writeFileSync(
    shim,
    `#!/bin/sh
case " $* " in
  *" fetch "*|*" pull "*|*" push "*|*" clone "*|*" ls-remote "*) echo "simulated network failure" >&2; exit 128;;
esac
exec ${realGit} "$@"
`,
    { mode: 0o755 },
  );
  const result = f.cli('update', '--apply');
  assert.notEqual(result.status, 0, 'a failed fetch must fail the update');
  assert.match(result.stderr + result.stdout, /simulated network failure/);
  assert.equal(readFileSync(v1.statePath, 'utf8'), v1.original, 'the schema 1 state must be untouched when the fetch fails');
  assert.equal(existsSync(v1.backup), false, 'a failed fetch must not leave a migration backup');
});

test('a schema 1 state migrates on the first apply: one backup, imported Pi packages, file removed', (t) => {
  const f = fixture(t);
  const v1 = installAsSchemaOne(f, ['npm:shared-one']);
  const machine = join(requireEnv(f.env, 'PI_CODING_AGENT_DIR'), 'settings.json');
  const settings = readJson(machine);
  writeFileSync(machine, JSON.stringify({ ...settings, packages: [...settings.packages, 'npm:shared-one', 'npm:personal'] }));

  const machineBefore = readFileSync(machine, 'utf8');
  good(f.maintain('sync'));
  good(f.maintain('status'));
  good(f.cli('setup', '--dry-run'));
  assert.equal(readFileSync(machine, 'utf8'), machineBefore);
  assert.equal(readFileSync(v1.statePath, 'utf8'), v1.original, 'previews migrate in memory only');
  assert.equal(existsSync(v1.backup), false);
  assert.equal(existsSync(v1.managed), true);

  good(f.maintain('sync', '--apply'));
  const migrated = readJson(v1.statePath);
  assert.equal(migrated.schema, 2);
  assert.equal(readFileSync(v1.backup, 'utf8'), v1.original);
  assert.deepEqual(skillNames(migrated, 'shared', 'owned'), Object.keys(JSON.parse(v1.original).skills).sort());
  assert.deepEqual(list(migrated, 'pi-package', 'pi'), [], 'the removed shared package is no longer owned after the pull');
  assert.equal(existsSync(v1.managed), false, 'the imported managed-packages.json is removed after a successful apply');
  const kept = readJson(machine).packages;
  assert.equal(kept.includes('npm:shared-one'), false, 'the imported ownership kept the dropped shared package removed');
  assert.equal(kept.includes('npm:personal'), true, 'a machine-only package survives');

  good(f.maintain('sync', '--apply'));
  assert.equal(readFileSync(v1.backup, 'utf8'), v1.original, 'the first backup is never rewritten');
});

test('state-rollback previews, restores schema 1 and the Pi package file, and refuses unrepresentable ledgers', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.source, 'config/pi/settings.json'), JSON.stringify({ packages: ['npm:shared-one'] }));
  good(f.cli('setup', '--agents', 'pi', '--source', f.source));
  const statePath = join(requireEnv(f.env, 'KITTO_HOME'), 'state.json'),
    before = readFileSync(statePath, 'utf8');
  const managed = join(f.source, 'config/pi/local/managed-packages.json');
  assert.equal(existsSync(managed), false);
  assert.deepEqual(
    list(readJson(statePath), 'pi-package', 'pi').map((entry) => entry.name),
    ['npm:shared-one'],
  );

  const preview = f.maintain('state-rollback');
  good(preview);
  assert.match(preview.stdout, /Preview only/);
  assert.equal(readFileSync(statePath, 'utf8'), before);

  const broken = readJson(statePath);
  broken.owned.skill.shared.pending = { hash: 'h', status: 'pending' };
  writeFileSync(statePath, JSON.stringify(broken, null, 2) + '\n');
  const refusedState = readFileSync(statePath, 'utf8');
  for (const args of [[], ['--apply']]) {
    const refused = f.maintain('state-rollback', ...args);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /pending skill shared\/pending/);
    assert.equal(readFileSync(statePath, 'utf8'), refusedState);
  }
  writeFileSync(statePath, before);

  good(f.maintain('state-rollback', '--apply'));
  const rolledBack = readJson(statePath);
  assert.equal(rolledBack.schema, 1);
  assert.equal(rolledBack.owned, undefined);
  assert.deepEqual(Object.keys(rolledBack.skills), ['example']);
  assert.deepEqual(readJson(managed), ['npm:shared-one']);
  good(f.maintain('state-rollback', '--apply'));
});

test('setup records the tool node and deploys the launcher only on apply; remove detaches it', (t) => {
  const f = fixture(t);
  const launcher = join(f.home, '.agents/bin/kitto-node');
  const statePath = join(requireEnv(f.env, 'KITTO_HOME'), 'state.json');
  const preview = f.cli('setup', '--agents', 'dsh', '--source', f.source, '--dry-run');
  good(preview);
  assert.match(preview.stdout, /tool node: \S+ \(v\d+\.\d+\.\d+, (mise|execPath)\)/);
  assert.match(preview.stdout, /launcher write: /);
  assert.equal(existsSync(launcher), false);
  assert.equal(existsSync(statePath), false);

  good(f.cli('setup', '--agents', 'dsh', '--source', f.source));
  const state = readJson(statePath);
  assert.equal(state.schema, 2);
  assert.equal(state.toolNode.path, process.execPath);
  assert.equal(state.toolNode.source, 'execPath');
  assert.equal(state.owned.launcher.shared['kitto-node'].status, 'owned');
  assert.equal(lstatSync(launcher).mode & 0o777, 0o755);
  const run = command(launcher, ['--version'], { PATH: '/usr/bin:/bin' });
  assert.equal(run.stdout.trim(), process.version);
  const status = f.maintain('status');
  good(status);
  assert.match(status.stdout, /"toolNode"/);
  assert.match(status.stdout, /launcher same: /);

  good(f.maintain('remove', '--apply'));
  assert.equal(existsSync(launcher), false);
  const detached = readJson(statePath);
  assert.equal(detached.toolNode, undefined);
  assert.equal(detached.owned.launcher?.shared?.['kitto-node'], undefined);
});

test('setup preserves a foreign file at the launcher path and warns', (t) => {
  const f = fixture(t);
  const launcher = join(f.home, '.agents/bin/kitto-node');
  mkdirSync(join(f.home, '.agents/bin'), { recursive: true });
  writeFileSync(launcher, foreignLauncher, { mode: 0o755 });
  const result = f.cli('setup', '--agents', 'dsh', '--source', f.source);
  good(result);
  assert.match(result.stderr, /Warning: .*kitto-node exists and is not an unmodified Kitto launcher/);
  assert.equal(readFileSync(launcher, 'utf8'), foreignLauncher);
  const state = readJson(join(requireEnv(f.env, 'KITTO_HOME'), 'state.json'));
  assert.equal(state.owned.launcher, undefined);
  good(f.maintain('remove', '--apply'));
  assert.equal(readFileSync(launcher, 'utf8'), foreignLauncher);
});
